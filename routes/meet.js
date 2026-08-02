const express = require('express');
const { nanoid } = require('nanoid');

const { pool } = require('../db');
const { ACTIVITIES, getActivity } = require('../lib/activities');
const { distanceMeters, formatDistance, isValidCoords } = require('../lib/geo');
const { isoString, fallbackWhen } = require('../lib/time');

const router = express.Router();

const COOKIE_NAME = 'ryadom_uid';
const COOKIE_MAX_AGE = 180 * 24 * 60 * 60 * 1000;
const RADIUS_OPTIONS = [
  { value: 1000, label: '1 км' },
  { value: 3000, label: '3 км' },
  { value: 10000, label: '10 км' },
  { value: 50000, label: '50 км' },
  { value: 0, label: 'везде' },
];
const DEFAULT_RADIUS = 10000;
// Встреча остаётся в ленте ещё два часа после начала — опоздавшие тоже могут дойти
const GRACE_HOURS = 2;

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// Профиль живёт в сессии, а долгоживущая кука позволяет вернуться к нему
// после перезапуска сервера (сессии хранятся в памяти).
async function attachProfile(req, res, next) {
  try {
    let profile = null;

    if (req.session.profileId) {
      const { rows } = await pool.query('SELECT * FROM meet_profiles WHERE id = $1', [
        req.session.profileId,
      ]);
      profile = rows[0] || null;
    }

    if (!profile) {
      const token = readCookie(req, COOKIE_NAME);
      if (token) {
        const { rows } = await pool.query('SELECT * FROM meet_profiles WHERE token = $1', [token]);
        profile = rows[0] || null;
        if (profile) req.session.profileId = profile.id;
      }
    }

    req.profile = profile;
    res.locals.profile = profile;
    next();
  } catch (err) {
    next(err);
  }
}

function requireProfile(req, res, next) {
  if (!req.profile) return res.redirect('/ryadom');
  next();
}

function currentCoords(req) {
  const lat = toCoord(req.session.lat);
  const lon = toCoord(req.session.lon);
  if (isValidCoords(lat, lon)) return { lat, lon };

  // У свежего профиля координат ещё нет — null нельзя приводить к числу,
  // иначе получится «валидная» точка 0,0.
  const profile = req.profile;
  if (profile && profile.lat != null && profile.lon != null) {
    const saved = { lat: Number(profile.lat), lon: Number(profile.lon) };
    if (isValidCoords(saved.lat, saved.lon)) return saved;
  }
  return null;
}

// Number('') и Number(null) дают 0 — для координат это точка в океане,
// поэтому пустое значение должно оставаться невалидным.
function toCoord(value) {
  const raw = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  if (!raw) return NaN;
  return Number(raw);
}

function clean(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function parseStartsAt(localValue, tzOffsetMinutes) {
  const local = String(localValue || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;

  const offset = Number(tzOffsetMinutes);
  const shift = Number.isFinite(offset) && Math.abs(offset) <= 900 ? offset : 0;
  const utcMs = Date.parse(`${local}:00Z`) + shift * 60000;
  if (!Number.isFinite(utcMs)) return null;

  const date = new Date(utcMs);
  const now = Date.now();
  if (utcMs < now - 60 * 60 * 1000) return null;
  if (utcMs > now + 30 * 24 * 60 * 60 * 1000) return null;
  return date;
}

function decorateMeet(meet, coords, profile) {
  const meters = coords
    ? distanceMeters(coords.lat, coords.lon, Number(meet.lat), Number(meet.lon))
    : null;

  return {
    ...meet,
    people: Number(meet.people),
    activityInfo: getActivity(meet.activity),
    meters,
    distanceText: formatDistance(meters),
    isHost: Boolean(profile) && meet.host_id === profile.id,
    isFull: Number(meet.people) >= meet.max_people,
  };
}

const FEED_SELECT = `
  SELECT m.*, p.name AS host_name,
         (SELECT COUNT(*) FROM meet_participants mp WHERE mp.meet_id = m.id) AS people,
         EXISTS (
           SELECT 1 FROM meet_participants mp
           WHERE mp.meet_id = m.id AND mp.profile_id = $1
         ) AS joined
  FROM meets m
  JOIN meet_profiles p ON p.id = m.host_id
`;

router.use((req, res, next) => {
  res.locals.isoString = isoString;
  res.locals.fallbackWhen = fallbackWhen;
  next();
});

router.use(attachProfile);

/* ---------- знакомство ---------- */

router.get('/', async (req, res, next) => {
  if (!req.profile) {
    return res.render('meet/welcome', { error: req.query.error || null });
  }

  try {
    const coords = currentCoords(req);
    const radius = RADIUS_OPTIONS.some((o) => o.value === Number(req.query.radius))
      ? Number(req.query.radius)
      : DEFAULT_RADIUS;
    const activity = ACTIVITIES.some((a) => a.id === req.query.activity) ? req.query.activity : '';

    const params = [req.profile.id];
    let sql = `${FEED_SELECT}
      WHERE NOT m.canceled
        AND m.starts_at > now() - interval '${GRACE_HOURS} hours'
        AND NOT EXISTS (
          SELECT 1 FROM meet_reports r WHERE r.meet_id = m.id AND r.profile_id = $1
        )`;

    if (activity) {
      params.push(activity);
      sql += ` AND m.activity = $${params.length}`;
    }

    sql += ' ORDER BY m.starts_at ASC LIMIT 200';

    const { rows } = await pool.query(sql, params);
    let meets = rows.map((row) => decorateMeet(row, coords, req.profile));

    const totalNearby = meets.length;
    if (coords && radius > 0) {
      meets = meets.filter((m) => m.meters <= radius);
    }

    res.render('meet/feed', {
      meets,
      coords,
      radius,
      radiusOptions: RADIUS_OPTIONS,
      activities: ACTIVITIES,
      activity,
      hiddenByRadius: totalNearby - meets.length,
      notice: req.query.notice || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/start', async (req, res, next) => {
  try {
    const name = clean(req.body.name, 40);
    const about = clean(req.body.about, 120);

    if (name.length < 2) {
      return res.redirect('/ryadom?error=' + encodeURIComponent('Напишите, как вас зовут'));
    }

    const token = nanoid(24);
    const { rows } = await pool.query(
      'INSERT INTO meet_profiles (token, name, about) VALUES ($1, $2, $3) RETURNING *',
      [token, name, about]
    );

    req.session.profileId = rows[0].id;
    res.cookie(COOKIE_NAME, token, {
      maxAge: COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.get('x-forwarded-proto') === 'https',
    });
    res.redirect('/ryadom');
  } catch (err) {
    next(err);
  }
});

/* ---------- геолокация ---------- */

router.post('/location', express.json(), async (req, res, next) => {
  try {
    const lat = toCoord(req.body.lat);
    const lon = toCoord(req.body.lon);
    if (!isValidCoords(lat, lon)) {
      return res.status(400).json({ ok: false, error: 'Некорректные координаты' });
    }

    req.session.lat = lat;
    req.session.lon = lon;

    if (req.profile) {
      await pool.query(
        'UPDATE meet_profiles SET lat = $1, lon = $2, location_updated_at = now() WHERE id = $3',
        [lat, lon, req.profile.id]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------- создание встречи ---------- */

router.get('/new', requireProfile, (req, res) => {
  res.render('meet/new', {
    activities: ACTIVITIES,
    coords: currentCoords(req),
    error: req.query.error || null,
    form: {
      activity: req.query.activity || 'coffee',
      place: req.query.place || '',
      note: req.query.note || '',
      max_people: req.query.max_people || 4,
    },
  });
});

router.post('/new', requireProfile, async (req, res, next) => {
  const back = (message) => res.redirect('/ryadom/new?error=' + encodeURIComponent(message));

  try {
    const activity = ACTIVITIES.some((a) => a.id === req.body.activity) ? req.body.activity : 'other';
    const place = clean(req.body.place, 80);
    const note = cleanMultiline(req.body.note, 300);
    const maxPeople = Math.min(12, Math.max(2, parseInt(req.body.max_people, 10) || 4));
    const lat = toCoord(req.body.lat);
    const lon = toCoord(req.body.lon);
    const startsAt = parseStartsAt(req.body.starts_at, req.body.tz_offset);

    if (place.length < 2) return back('Напишите, где встречаемся');
    if (!startsAt) return back('Выберите время встречи — от текущего момента и до 30 дней вперёд');
    if (!isValidCoords(lat, lon)) {
      return back('Не удалось определить место на карте — разрешите доступ к геолокации');
    }

    const slug = nanoid(10);
    const { rows } = await pool.query(
      `INSERT INTO meets (slug, host_id, activity, place, note, lat, lon, starts_at, max_people)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, slug`,
      [slug, req.profile.id, activity, place, note, lat, lon, startsAt, maxPeople]
    );

    await pool.query(
      'INSERT INTO meet_participants (meet_id, profile_id) VALUES ($1, $2)',
      [rows[0].id, req.profile.id]
    );

    res.redirect(`/ryadom/p/${rows[0].slug}`);
  } catch (err) {
    next(err);
  }
});

/* ---------- страница встречи ---------- */

async function loadMeet(req, res, next) {
  try {
    const { rows } = await pool.query(`${FEED_SELECT} WHERE m.slug = $2`, [
      req.profile.id,
      req.params.slug,
    ]);
    if (!rows.length) return res.status(404).render('404');
    req.meet = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/p/:slug', requireProfile, loadMeet, async (req, res, next) => {
  try {
    const [{ rows: people }, { rows: messages }] = await Promise.all([
      pool.query(
        `SELECT p.id, p.name, p.about, mp.created_at
         FROM meet_participants mp
         JOIN meet_profiles p ON p.id = mp.profile_id
         WHERE mp.meet_id = $1
         ORDER BY mp.created_at ASC`,
        [req.meet.id]
      ),
      pool.query(
        `SELECT m.id, m.text, m.created_at, p.name AS author, p.id AS author_id
         FROM meet_messages m
         JOIN meet_profiles p ON p.id = m.profile_id
         WHERE m.meet_id = $1
         ORDER BY m.created_at ASC
         LIMIT 200`,
        [req.meet.id]
      ),
    ]);

    res.render('meet/meet', {
      meet: decorateMeet(req.meet, currentCoords(req), req.profile),
      people,
      messages,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/p/:slug/join', requireProfile, loadMeet, async (req, res, next) => {
  try {
    if (req.meet.canceled) {
      return res.redirect(`/ryadom/p/${req.meet.slug}?error=` + encodeURIComponent('Встреча отменена'));
    }
    if (Number(req.meet.people) >= req.meet.max_people && !req.meet.joined) {
      return res.redirect(
        `/ryadom/p/${req.meet.slug}?error=` + encodeURIComponent('Мест уже нет')
      );
    }

    await pool.query(
      `INSERT INTO meet_participants (meet_id, profile_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.meet.id, req.profile.id]
    );
    res.redirect(`/ryadom/p/${req.meet.slug}`);
  } catch (err) {
    next(err);
  }
});

router.post('/p/:slug/leave', requireProfile, loadMeet, async (req, res, next) => {
  try {
    if (req.meet.host_id === req.profile.id) {
      return res.redirect(
        `/ryadom/p/${req.meet.slug}?error=` +
          encodeURIComponent('Вы организатор — встречу можно только отменить')
      );
    }
    await pool.query('DELETE FROM meet_participants WHERE meet_id = $1 AND profile_id = $2', [
      req.meet.id,
      req.profile.id,
    ]);
    res.redirect(`/ryadom/p/${req.meet.slug}`);
  } catch (err) {
    next(err);
  }
});

router.post('/p/:slug/cancel', requireProfile, loadMeet, async (req, res, next) => {
  try {
    if (req.meet.host_id !== req.profile.id) return res.status(403).render('404');
    await pool.query('UPDATE meets SET canceled = true WHERE id = $1', [req.meet.id]);
    res.redirect('/ryadom?notice=' + encodeURIComponent('Встреча отменена'));
  } catch (err) {
    next(err);
  }
});

router.post('/p/:slug/messages', requireProfile, loadMeet, async (req, res, next) => {
  try {
    if (!req.meet.joined) {
      return res.redirect(
        `/ryadom/p/${req.meet.slug}?error=` +
          encodeURIComponent('Сначала присоединитесь к встрече')
      );
    }

    const text = cleanMultiline(req.body.text, 500);
    if (!text) return res.redirect(`/ryadom/p/${req.meet.slug}`);

    await pool.query('INSERT INTO meet_messages (meet_id, profile_id, text) VALUES ($1, $2, $3)', [
      req.meet.id,
      req.profile.id,
      text,
    ]);
    res.redirect(`/ryadom/p/${req.meet.slug}#chat`);
  } catch (err) {
    next(err);
  }
});

router.post('/p/:slug/report', requireProfile, loadMeet, async (req, res, next) => {
  try {
    const reason = clean(req.body.reason, 200);
    await pool.query(
      `INSERT INTO meet_reports (meet_id, profile_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (meet_id, profile_id) DO UPDATE SET reason = EXCLUDED.reason`,
      [req.meet.id, req.profile.id, reason]
    );
    await pool.query('DELETE FROM meet_participants WHERE meet_id = $1 AND profile_id = $2', [
      req.meet.id,
      req.profile.id,
    ]);
    res.redirect(
      '/ryadom?notice=' + encodeURIComponent('Спасибо, встреча скрыта из вашей ленты')
    );
  } catch (err) {
    next(err);
  }
});

/* ---------- профиль ---------- */

router.get('/me', requireProfile, async (req, res, next) => {
  try {
    const coords = currentCoords(req);
    const { rows } = await pool.query(
      `${FEED_SELECT}
       WHERE NOT m.canceled
         AND m.starts_at > now() - interval '${GRACE_HOURS} hours'
         AND EXISTS (
           SELECT 1 FROM meet_participants mp
           WHERE mp.meet_id = m.id AND mp.profile_id = $1
         )
       ORDER BY m.starts_at ASC`,
      [req.profile.id]
    );

    res.render('meet/me', {
      meets: rows.map((row) => decorateMeet(row, coords, req.profile)),
      notice: req.query.notice || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/me', requireProfile, async (req, res, next) => {
  try {
    const name = clean(req.body.name, 40);
    const about = clean(req.body.about, 120);
    if (name.length < 2) {
      return res.redirect('/ryadom/me?notice=' + encodeURIComponent('Имя слишком короткое'));
    }
    await pool.query('UPDATE meet_profiles SET name = $1, about = $2 WHERE id = $3', [
      name,
      about,
      req.profile.id,
    ]);
    res.redirect('/ryadom/me?notice=' + encodeURIComponent('Профиль обновлён'));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  delete req.session.profileId;
  delete req.session.lat;
  delete req.session.lon;
  res.clearCookie(COOKIE_NAME);
  res.redirect('/ryadom');
});

module.exports = router;
