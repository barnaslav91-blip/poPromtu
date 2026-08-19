const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');

const { pool } = require('../db');
const { requireAuth } = require('../lib/auth');
const {
  NETWORKS,
  TEMPLATE_KINDS,
  LEAD_STATUSES,
  REJECT_REASONS,
  buildCombos,
  composeText,
  pickCombo,
  pickImage,
  seedTemplates,
} = require('../lib/promo');
const { isEnabled, sendMessage, escapeHtml } = require('../lib/telegram');

const router = express.Router();

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    cb(null, ALLOWED_IMAGE_TYPES.includes(file.mimetype));
  },
});

router.use(requireAuth);

async function loadClient(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(404).render('404');

    const { rows } = await pool.query('SELECT * FROM promo_clients WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).render('404');
    req.client = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

function backToClient(res, clientId, tab, error, notice) {
  const params = [];
  if (error) params.push(`error=${encodeURIComponent(error)}`);
  if (notice) params.push(`notice=${encodeURIComponent(notice)}`);
  const suffix = params.length ? `&${params.join('&')}` : '';
  res.redirect(`/promo/clients/${clientId}?tab=${tab || 'groups'}${suffix}`);
}

/** Группы, в которые сегодня можно постить: активные, без запланированного поста и с выдержанным интервалом. */
async function eligibleGroups(clientId) {
  const { rows } = await pool.query(
    `SELECT g.*,
       (SELECT MAX(p.posted_at) FROM promo_posts p
          WHERE p.group_id = g.id AND p.status = 'posted') AS last_posted_at,
       (SELECT COUNT(*) FROM promo_posts p
          WHERE p.group_id = g.id AND p.status = 'planned')::int AS planned_count
     FROM promo_groups g
     WHERE g.client_id = $1 AND g.active = true
     ORDER BY last_posted_at ASC NULLS FIRST, g.id ASC`,
    [clientId]
  );

  const now = Date.now();
  return rows.filter((group) => {
    if (group.planned_count > 0) return false;
    if (!group.last_posted_at) return true;
    const elapsedDays = (now - new Date(group.last_posted_at).getTime()) / 86400000;
    return elapsedDays >= group.min_interval_days;
  });
}

async function recentInGroup(groupId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT combo_key, image_id FROM promo_posts
     WHERE group_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [groupId, limit]
  );
  return {
    comboKeys: rows.map((r) => r.combo_key),
    imageIds: rows.map((r) => r.image_id),
  };
}

async function loadContent(clientId) {
  const { rows: templates } = await pool.query(
    'SELECT * FROM promo_templates WHERE client_id = $1 ORDER BY kind, id',
    [clientId]
  );
  // data не выбираем: это байты файла, они нужны только при отдаче картинки.
  const { rows: images } = await pool.query(
    `SELECT id, client_id, url, caption, mime, filename, active
     FROM promo_images WHERE client_id = $1 ORDER BY id`,
    [clientId]
  );
  return { templates, images, combos: buildCombos(templates) };
}

// ---------------------------------------------------------------- клиенты

router.get('/', async (req, res, next) => {
  try {
    const { rows: clients } = await pool.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM promo_groups g WHERE g.client_id = c.id AND g.active)::int AS groups_count,
         (SELECT COUNT(*) FROM promo_posts p
            WHERE p.client_id = c.id AND p.status = 'planned')::int AS planned_count,
         (SELECT COUNT(*) FROM promo_leads l
            WHERE l.client_id = c.id AND l.status = 'new')::int AS new_leads
       FROM promo_clients c
       ORDER BY c.active DESC, c.name`
    );

    res.render('promo/dashboard', {
      clients,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/clients', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.redirect('/promo?error=' + encodeURIComponent('Укажите название клиента'));
    }

    const { rows } = await pool.query(
      `INSERT INTO promo_clients (token, name, service, city, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        nanoid(12),
        name,
        (req.body.service || '').trim(),
        (req.body.city || '').trim(),
        (req.body.phone || '').trim(),
      ]
    );

    res.redirect(`/promo/clients/${rows[0].id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:id', loadClient, async (req, res, next) => {
  try {
    const { templates, images, combos } = await loadContent(req.client.id);

    const { rows: groups } = await pool.query(
      `SELECT g.*,
         (SELECT MAX(p.posted_at) FROM promo_posts p
            WHERE p.group_id = g.id AND p.status = 'posted') AS last_posted_at,
         (SELECT COUNT(*) FROM promo_posts p
            WHERE p.group_id = g.id AND p.status = 'posted')::int AS posts_count
       FROM promo_groups g WHERE g.client_id = $1
       ORDER BY g.active DESC, g.network, g.name`,
      [req.client.id]
    );

    res.render('promo/client', {
      client: req.client,
      groups,
      templates,
      images,
      combosCount: combos.length,
      networks: NETWORKS,
      templateKinds: TEMPLATE_KINDS,
      tab: req.query.tab || 'groups',
      error: req.query.error || null,
      notice: req.query.notice || null,
      telegramReady: isEnabled(),
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/clients/:id/update', loadClient, async (req, res, next) => {
  try {
    const postsPerDay = Math.min(20, Math.max(1, parseInt(req.body.posts_per_day, 10) || 3));
    const dedupDays = Math.min(365, Math.max(0, parseInt(req.body.dedup_days, 10) || 0));
    const pricePerLead = Math.max(0, parseFloat(req.body.price_per_lead) || 0);

    await pool.query(
      `UPDATE promo_clients
       SET name = $1, service = $2, city = $3, phone = $4, price_from = $5,
           price_per_lead = $6, posts_per_day = $7, dedup_days = $8, active = $9,
           telegram_chat_id = $10
       WHERE id = $11`,
      [
        (req.body.name || '').trim() || req.client.name,
        (req.body.service || '').trim(),
        (req.body.city || '').trim(),
        (req.body.phone || '').trim(),
        (req.body.price_from || '').trim(),
        pricePerLead,
        postsPerDay,
        dedupDays,
        req.body.active === 'on',
        (req.body.telegram_chat_id || '').trim(),
        req.client.id,
      ]
    );

    backToClient(res, req.client.id, 'settings');
  } catch (err) {
    next(err);
  }
});

router.post('/clients/:id/telegram/test', loadClient, async (req, res, next) => {
  try {
    if (!isEnabled()) {
      return backToClient(res, req.client.id, 'settings', 'TELEGRAM_BOT_TOKEN не задан на сервере');
    }

    const targets = [process.env.TELEGRAM_ADMIN_CHAT_ID, req.client.telegram_chat_id].filter(
      Boolean
    );
    if (!targets.length) {
      return backToClient(
        res,
        req.client.id,
        'settings',
        'Некуда слать: укажите chat id клиента или TELEGRAM_ADMIN_CHAT_ID'
      );
    }

    const failures = [];
    for (const chatId of new Set(targets)) {
      const result = await sendMessage(
        chatId,
        `<b>poPromtu Промо</b>\nПроверка связи по клиенту «${escapeHtml(req.client.name)}». ` +
          'Если вы это видите — уведомления о заявках будут приходить сюда.'
      );
      if (!result.ok) failures.push(`${chatId}: ${result.error}`);
    }

    backToClient(
      res,
      req.client.id,
      'settings',
      failures.length ? `Не доставлено — ${failures.join('; ')}` : null,
      failures.length ? null : 'Проверочное сообщение отправлено'
    );
  } catch (err) {
    next(err);
  }
});

router.post('/clients/:id/delete', loadClient, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM promo_clients WHERE id = $1', [req.client.id]);
    res.redirect('/promo');
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- группы

router.post('/clients/:id/groups', loadClient, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return backToClient(res, req.client.id, 'groups', 'Укажите название группы');

    const network = NETWORKS[req.body.network] ? req.body.network : 'other';
    const interval = Math.min(90, Math.max(1, parseInt(req.body.min_interval_days, 10) || 7));

    await pool.query(
      `INSERT INTO promo_groups (client_id, network, name, url, min_interval_days)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.client.id, network, name, (req.body.url || '').trim(), interval]
    );

    backToClient(res, req.client.id, 'groups');
  } catch (err) {
    next(err);
  }
});

router.post('/groups/:groupId/toggle', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'UPDATE promo_groups SET active = NOT active WHERE id = $1 RETURNING client_id',
      [req.params.groupId]
    );
    if (!rows[0]) return res.status(404).render('404');
    backToClient(res, rows[0].client_id, 'groups');
  } catch (err) {
    next(err);
  }
});

router.post('/groups/:groupId/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM promo_groups WHERE id = $1 RETURNING client_id',
      [req.params.groupId]
    );
    if (!rows[0]) return res.status(404).render('404');
    backToClient(res, rows[0].client_id, 'groups');
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- шаблоны

router.post('/clients/:id/templates', loadClient, async (req, res, next) => {
  try {
    const text = (req.body.text || '').trim();
    const kind = TEMPLATE_KINDS[req.body.kind] ? req.body.kind : null;

    if (!text || !kind) {
      return backToClient(res, req.client.id, 'templates', 'Выберите тип и напишите текст');
    }

    await pool.query('INSERT INTO promo_templates (client_id, kind, text) VALUES ($1, $2, $3)', [
      req.client.id,
      kind,
      text,
    ]);

    backToClient(res, req.client.id, 'templates');
  } catch (err) {
    next(err);
  }
});

router.post('/clients/:id/templates/seed', loadClient, async (req, res, next) => {
  try {
    const rows = seedTemplates(req.client.service);
    for (const row of rows) {
      await pool.query(
        'INSERT INTO promo_templates (client_id, kind, text) VALUES ($1, $2, $3)',
        [req.client.id, row.kind, row.text]
      );
    }
    backToClient(res, req.client.id, 'templates');
  } catch (err) {
    next(err);
  }
});

router.post('/templates/:templateId/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM promo_templates WHERE id = $1 RETURNING client_id',
      [req.params.templateId]
    );
    if (!rows[0]) return res.status(404).render('404');
    backToClient(res, rows[0].client_id, 'templates');
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- картинки

router.post('/clients/:id/images', loadClient, async (req, res, next) => {
  try {
    const url = (req.body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return backToClient(res, req.client.id, 'images', 'Нужна прямая ссылка на картинку (http/https)');
    }

    await pool.query('INSERT INTO promo_images (client_id, url, caption) VALUES ($1, $2, $3)', [
      req.client.id,
      url,
      (req.body.caption || '').trim(),
    ]);

    backToClient(res, req.client.id, 'images');
  } catch (err) {
    next(err);
  }
});

function uploadSingleImage(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Файл больше 5 МБ — сожмите картинку'
        : 'Не удалось прочитать файл';
    backToClient(res, req.params.id, 'images', message);
  });
}

router.post('/clients/:id/images/upload', uploadSingleImage, loadClient, async (req, res, next) => {
  try {
    if (!req.file) {
      return backToClient(res, req.client.id, 'images', 'Выберите файл JPEG, PNG или WebP');
    }

    await pool.query(
      `INSERT INTO promo_images (client_id, url, caption, data, mime, filename)
       VALUES ($1, '', $2, $3, $4, $5)`,
      [
        req.client.id,
        (req.body.caption || '').trim(),
        req.file.buffer,
        req.file.mimetype,
        (req.file.originalname || 'image').slice(0, 120),
      ]
    );

    backToClient(res, req.client.id, 'images');
  } catch (err) {
    next(err);
  }
});

router.post('/images/:imageId/delete', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM promo_images WHERE id = $1 RETURNING client_id',
      [req.params.imageId]
    );
    if (!rows[0]) return res.status(404).render('404');
    backToClient(res, rows[0].client_id, 'images');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ очередь

router.post('/clients/:id/plan', loadClient, async (req, res, next) => {
  try {
    const { images, combos } = await loadContent(req.client.id);
    if (!combos.length) {
      return backToClient(
        res,
        req.client.id,
        'templates',
        'Нужен хотя бы один заголовок и один основной текст'
      );
    }

    const groups = (await eligibleGroups(req.client.id)).slice(0, req.client.posts_per_day);

    for (const group of groups) {
      const recent = await recentInGroup(group.id);
      const combo = pickCombo(combos, recent.comboKeys);
      const image = pickImage(images, recent.imageIds);

      await pool.query(
        `INSERT INTO promo_posts (client_id, group_id, text, combo_key, image_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.client.id, group.id, composeText(combo, req.client), combo.key, image ? image.id : null]
      );
    }

    res.redirect(`/promo/clients/${req.client.id}/queue`);
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:id/queue', loadClient, async (req, res, next) => {
  try {
    const { rows: posts } = await pool.query(
      `SELECT p.*, g.name AS group_name, g.url AS group_url, g.network,
              COALESCE(NULLIF(i.url, ''), '/img/' || i.id) AS image_url,
              CASE WHEN i.id IS NULL THEN NULL
                   WHEN i.url <> '' THEN i.url
                   ELSE '/img/' || i.id || '?download=1' END AS image_download,
              i.caption AS image_caption
       FROM promo_posts p
       JOIN promo_groups g ON g.id = p.group_id
       LEFT JOIN promo_images i ON i.id = p.image_id
       WHERE p.client_id = $1 AND p.status = 'planned'
       ORDER BY p.created_at`,
      [req.client.id]
    );

    const { rows: history } = await pool.query(
      `SELECT p.posted_at, p.status, g.name AS group_name, g.network
       FROM promo_posts p
       JOIN promo_groups g ON g.id = p.group_id
       WHERE p.client_id = $1 AND p.status <> 'planned'
       ORDER BY COALESCE(p.posted_at, p.created_at) DESC
       LIMIT 15`,
      [req.client.id]
    );

    const available = await eligibleGroups(req.client.id);

    res.render('promo/queue', {
      client: req.client,
      posts,
      history,
      availableCount: available.length,
      networks: NETWORKS,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/posts/:postId/posted', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE promo_posts SET status = 'posted', posted_at = now()
       WHERE id = $1 RETURNING client_id`,
      [req.params.postId]
    );
    if (!rows[0]) return res.status(404).render('404');
    res.redirect(`/promo/clients/${rows[0].client_id}/queue`);
  } catch (err) {
    next(err);
  }
});

router.post('/posts/:postId/skip', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE promo_posts SET status = 'skipped' WHERE id = $1 RETURNING client_id`,
      [req.params.postId]
    );
    if (!rows[0]) return res.status(404).render('404');
    res.redirect(`/promo/clients/${rows[0].client_id}/queue`);
  } catch (err) {
    next(err);
  }
});

router.post('/posts/:postId/regenerate', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM promo_posts WHERE id = $1', [
      req.params.postId,
    ]);
    const post = rows[0];
    if (!post) return res.status(404).render('404');

    const { rows: clientRows } = await pool.query('SELECT * FROM promo_clients WHERE id = $1', [
      post.client_id,
    ]);
    const client = clientRows[0];

    const { images, combos } = await loadContent(client.id);
    if (!combos.length) {
      return res.redirect(`/promo/clients/${client.id}/queue`);
    }

    const recent = await recentInGroup(post.group_id);
    // Текущий вариант тоже считаем «свежим», чтобы кнопка давала именно другой текст.
    const combo = pickCombo(combos, [post.combo_key, ...recent.comboKeys]);
    const image = pickImage(images, [post.image_id, ...recent.imageIds]);

    await pool.query('UPDATE promo_posts SET text = $1, combo_key = $2, image_id = $3 WHERE id = $4', [
      composeText(combo, client),
      combo.key,
      image ? image.id : null,
      post.id,
    ]);

    res.redirect(`/promo/clients/${client.id}/queue`);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- заявки

router.get('/clients/:id/leads', loadClient, async (req, res, next) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '')
      ? req.query.period
      : new Date().toISOString().slice(0, 7);

    const { rows: leads } = await pool.query(
      `SELECT l.*, g.name AS group_name
       FROM promo_leads l
       LEFT JOIN promo_groups g ON g.id = l.group_id
       WHERE l.client_id = $1 AND to_char(l.created_at, 'YYYY-MM') = $2
       ORDER BY l.created_at DESC`,
      [req.client.id, period]
    );

    const { rows: bySource } = await pool.query(
      `SELECT COALESCE(g.name, 'Без источника') AS group_name,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE l.status = 'accepted')::int AS accepted
       FROM promo_leads l
       LEFT JOIN promo_groups g ON g.id = l.group_id
       WHERE l.client_id = $1 AND to_char(l.created_at, 'YYYY-MM') = $2
       GROUP BY g.name
       ORDER BY total DESC`,
      [req.client.id, period]
    );

    const accepted = leads.filter((l) => l.status === 'accepted');
    const billing = {
      accepted: accepted.length,
      rejected: leads.filter((l) => l.status === 'rejected').length,
      pending: leads.filter((l) => l.status === 'new').length,
      duplicates: leads.filter((l) => l.is_duplicate).length,
      total: accepted.reduce((sum, l) => sum + Number(l.price), 0),
    };

    res.render('promo/leads', {
      client: req.client,
      leads,
      bySource,
      billing,
      period,
      leadStatuses: LEAD_STATUSES,
      rejectReasons: REJECT_REASONS,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/leads/:leadId/status', async (req, res, next) => {
  try {
    const status = LEAD_STATUSES[req.body.status] ? req.body.status : 'new';
    const { rows } = await pool.query(
      'UPDATE promo_leads SET status = $1, reject_reason = $2 WHERE id = $3 RETURNING client_id',
      [status, status === 'rejected' ? (req.body.reject_reason || '').trim() : '', req.params.leadId]
    );
    if (!rows[0]) return res.status(404).render('404');
    res.redirect(`/promo/clients/${rows[0].client_id}/leads`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
