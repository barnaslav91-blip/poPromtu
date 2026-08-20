const express = require('express');

const { pool } = require('../db');
const {
  LEAD_STATUSES,
  REJECT_REASONS,
  DISPUTE_HOURS,
  normalizePhone,
  phoneKey,
  isAutoAccepted,
  effectiveStatus,
  localized,
} = require('../lib/promo');
const { notifyLead } = require('../lib/telegram');

const router = express.Router();

/**
 * Уведомление в Telegram отправляется в фоне: заявка уже сохранена,
 * и человек не должен ждать ответа от чужого API.
 */
function notifyInBackground(client, lead, baseUrl) {
  (async () => {
    let groupName = '';
    if (lead.group_id) {
      const { rows } = await pool.query('SELECT name FROM promo_groups WHERE id = $1', [
        lead.group_id,
      ]);
      groupName = rows[0] ? rows[0].name : '';
    }
    await notifyLead(client, lead, groupName, `${baseUrl}/c/${client.token}`);
  })().catch((err) => console.error('Telegram: сбой уведомления —', err.message));
}

async function loadByToken(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM promo_clients WHERE token = $1', [
      req.params.token,
    ]);
    if (!rows[0]) return res.status(404).render('404');
    req.client = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Записывает заявку. Дубль по телефону в пределах dedup_days не тарифицируется —
 * это п. 1.3 договора, а не «на глаз».
 */
async function createLead(client, { name, phone, message, source, groupId }) {
  const key = phoneKey(phone);
  let isDuplicate = false;

  if (key && client.dedup_days > 0) {
    const { rows } = await pool.query(
      `SELECT 1 FROM promo_leads
       WHERE client_id = $1
         AND phone_key = $2
         AND created_at > now() - ($3 || ' days')::interval
       LIMIT 1`,
      [client.id, key, String(client.dedup_days)]
    );
    isDuplicate = rows.length > 0;
  }

  const { rows } = await pool.query(
    `INSERT INTO promo_leads
       (client_id, group_id, name, phone, phone_key, message, source, is_duplicate, price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      client.id,
      groupId,
      (name || '').trim().slice(0, 120),
      (phone || '').trim().slice(0, 40),
      key,
      (message || '').trim().slice(0, 2000),
      (source || '').trim().slice(0, 120),
      isDuplicate,
      isDuplicate ? 0 : client.price_per_lead,
    ]
  );

  return rows[0];
}

async function resolveGroupId(clientId, rawId) {
  const group = await resolveGroup(clientId, rawId);
  return group ? group.id : null;
}

async function resolveGroup(clientId, rawId) {
  const groupId = parseInt(rawId, 10);
  if (!groupId) return null;
  const { rows } = await pool.query(
    'SELECT id, lang FROM promo_groups WHERE id = $1 AND client_id = $2',
    [groupId, clientId]
  );
  return rows[0] || null;
}

// Человек пришёл из румынской группы — форму он должен увидеть на румынском.
const LANDING_TEXT = {
  ru: {
    region: 'и район',
    callHint: 'Звоните или оставьте номер — перезвоню сам.',
    sentTitle: 'Заявка принята',
    sentBody: 'свяжется с вами в ближайшее время.',
    sentThanks: 'Спасибо!',
    formTitle: 'Оставить заявку',
    name: 'Как к вам обращаться',
    phone: 'Телефон',
    message: 'Что нужно сделать',
    messageHint: 'Двор примерно 5 соток, трава по пояс',
    submit: 'Отправить',
    consent:
      'Отправляя заявку, вы соглашаетесь на обработку указанных данных ' +
      'для связи с вами по этому обращению.',
    phoneError: 'Укажите номер телефона',
  },
  ro: {
    region: 'și împrejurimi',
    callHint: 'Sunați sau lăsați numărul — vă sun eu.',
    sentTitle: 'Cererea a fost primită',
    sentBody: 'vă va contacta în cel mai scurt timp.',
    sentThanks: 'Mulțumim!',
    formTitle: 'Lăsați o cerere',
    name: 'Cum vă numiți',
    phone: 'Telefon',
    message: 'Ce trebuie făcut',
    messageHint: 'Curte de circa 5 ari, iarbă până la brâu',
    submit: 'Trimite',
    consent:
      'Trimițând cererea, sunteți de acord cu prelucrarea datelor indicate ' +
      'pentru a fi contactat în legătură cu această solicitare.',
    phoneError: 'Indicați numărul de telefon',
  },
};

function landingLang(group) {
  return group && LANDING_TEXT[group.lang] ? group.lang : 'ru';
}

// ------------------------------------------------------------- картинки

// Отдаёт загруженный в базу файл. Картинки всё равно уходят в публичные
// группы, поэтому доступ по прямой ссылке — то, что нужно.
router.get('/img/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(404).render('404');

    const { rows } = await pool.query(
      'SELECT data, mime, filename FROM promo_images WHERE id = $1',
      [id]
    );
    const image = rows[0];
    if (!image || !image.data) return res.status(404).render('404');

    res.set('Content-Type', image.mime || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=86400');
    if (req.query.download === '1') {
      const safeName = (image.filename || 'image').replace(/[^\w.-]/g, '_');
      res.set('Content-Disposition', `attachment; filename="${safeName}"`);
    }
    res.send(image.data);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- публичный лендинг

router.get('/l/:token/:groupId?', loadByToken, async (req, res, next) => {
  try {
    const group = await resolveGroup(req.client.id, req.params.groupId);
    const lang = landingLang(group);
    res.render('landing', {
      client: req.client,
      groupId: group ? group.id : null,
      lang,
      L: localized(req.client, lang),
      t: LANDING_TEXT[lang],
      sent: req.query.sent === '1',
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/l/:token', loadByToken, async (req, res, next) => {
  try {
    const phone = (req.body.phone || '').trim();
    const group = await resolveGroup(req.client.id, req.body.group_id);
    const groupId = group ? group.id : null;
    const back = `/l/${req.client.token}${groupId ? '/' + groupId : ''}`;

    if (normalizePhone(phone).length < 6) {
      const message = LANDING_TEXT[landingLang(group)].phoneError;
      return res.redirect(back + '?error=' + encodeURIComponent(message));
    }

    const lead = await createLead(req.client, {
      name: req.body.name,
      phone,
      message: req.body.message,
      source: 'landing',
      groupId,
    });

    notifyInBackground(req.client, lead, `${req.protocol}://${req.get('host')}`);
    res.redirect(back + '?sent=1');
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------- вебхук для n8n / форм

router.post('/api/lead/:token', express.json(), loadByToken, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (normalizePhone(body.phone).length < 6) {
      return res.status(400).json({ ok: false, error: 'phone required' });
    }

    const groupId = await resolveGroupId(req.client.id, body.group_id);
    const lead = await createLead(req.client, {
      name: body.name,
      phone: body.phone,
      message: body.message,
      source: body.source || 'api',
      groupId,
    });

    notifyInBackground(req.client, lead, `${req.protocol}://${req.get('host')}`);
    res.json({ ok: true, id: lead.id, duplicate: lead.is_duplicate });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------- кабинет клиента

function disputeState(lead) {
  const hours = (Date.now() - new Date(lead.created_at).getTime()) / 3600000;
  return {
    hoursLeft: Math.max(0, DISPUTE_HOURS - hours),
    canDispute: lead.status === 'new' && hours < DISPUTE_HOURS,
  };
}

router.get('/c/:token', loadByToken, async (req, res, next) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '')
      ? req.query.period
      : new Date().toISOString().slice(0, 7);

    const { rows } = await pool.query(
      `SELECT l.*, g.name AS group_name
       FROM promo_leads l
       LEFT JOIN promo_groups g ON g.id = l.group_id
       WHERE l.client_id = $1 AND to_char(l.created_at, 'YYYY-MM') = $2
       ORDER BY l.created_at DESC`,
      [req.client.id, period]
    );

    const leads = rows.map((lead) => ({
      ...lead,
      ...disputeState(lead),
      effective: effectiveStatus(lead),
      auto: isAutoAccepted(lead),
    }));
    const billable = leads.filter((l) => l.effective === 'accepted');

    res.render('client/cabinet', {
      client: req.client,
      leads,
      period,
      disputeHours: DISPUTE_HOURS,
      leadStatuses: LEAD_STATUSES,
      rejectReasons: REJECT_REASONS,
      summary: {
        total: leads.length,
        pending: leads.filter((l) => l.effective === 'new').length,
        accepted: billable.length,
        rejected: leads.filter((l) => l.effective === 'rejected').length,
        amount: billable.reduce((sum, l) => sum + Number(l.price), 0),
      },
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/c/:token/leads/:leadId', loadByToken, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM promo_leads WHERE id = $1 AND client_id = $2',
      [req.params.leadId, req.client.id]
    );
    const lead = rows[0];
    if (!lead) return res.status(404).render('404');

    const back = `/c/${req.client.token}`;
    const action = req.body.action;

    if (action === 'accept') {
      await pool.query("UPDATE promo_leads SET status = 'accepted' WHERE id = $1", [lead.id]);
      return res.redirect(back);
    }

    if (action === 'reject') {
      const { canDispute } = disputeState(lead);
      if (!canDispute) {
        return res.redirect(
          back +
            '?error=' +
            encodeURIComponent(`Срок возражения (${DISPUTE_HOURS} ч) истёк — заявка принята`)
        );
      }

      const reason = (req.body.reject_reason || '').trim();
      if (!REJECT_REASONS.includes(reason)) {
        return res.redirect(back + '?error=' + encodeURIComponent('Выберите причину из списка'));
      }

      await pool.query(
        "UPDATE promo_leads SET status = 'rejected', reject_reason = $1 WHERE id = $2",
        [reason, lead.id]
      );
    }

    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
