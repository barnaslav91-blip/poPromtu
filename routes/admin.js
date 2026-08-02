const express = require('express');
const { nanoid } = require('nanoid');

const { pool } = require('../db');
const { extractYoutubeId } = require('../lib/youtube');
const { getActivity } = require('../lib/activities');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.render('admin/login', {
      error: 'ADMIN_PASSWORD не задан на сервере (см. .env.example).',
    });
  }

  if (password === adminPassword) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }

  res.render('admin/login', { error: 'Неверный пароль' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { rows: videos } = await pool.query(`
      SELECT v.*,
        (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id)::int AS total_comments,
        (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.resolved = false)::int AS open_comments
      FROM videos v ORDER BY v.created_at DESC
    `);
    const { rows: reviewers } = await pool.query('SELECT * FROM reviewers ORDER BY name');

    res.render('admin/dashboard', {
      videos,
      reviewers,
      error: req.query.error || null,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
  } catch (err) {
    next(err);
  }
});

// Сводка по «Рядом» — чтобы после живого теста было видно, что реально произошло
router.get('/ryadom', async (req, res, next) => {
  try {
    const [{ rows: totals }, { rows: recent }, { rows: reports }] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM meet_profiles)::int AS profiles,
          (SELECT COUNT(*) FROM meet_profiles WHERE created_at > now() - interval '7 days')::int AS profiles_week,
          (SELECT COUNT(*) FROM meets)::int AS meets,
          (SELECT COUNT(*) FROM meets WHERE NOT canceled AND starts_at > now())::int AS meets_upcoming,
          (SELECT COUNT(*) FROM meets WHERE canceled)::int AS meets_canceled,
          (SELECT COUNT(*) FROM meet_participants)::int AS participants,
          (SELECT COUNT(*) FROM meet_messages)::int AS messages,
          (SELECT COUNT(*) FROM meet_reports)::int AS reports,
          (SELECT COUNT(*) FROM (
             SELECT meet_id FROM meet_participants GROUP BY meet_id HAVING COUNT(*) > 1
           ) AS joined_meets)::int AS meets_with_guests
      `),
      pool.query(`
        SELECT m.slug, m.activity, m.place, m.starts_at, m.canceled, p.name AS host_name,
               (SELECT COUNT(*) FROM meet_participants mp WHERE mp.meet_id = m.id)::int AS people
        FROM meets m
        JOIN meet_profiles p ON p.id = m.host_id
        ORDER BY m.created_at DESC
        LIMIT 30
      `),
      pool.query(`
        SELECT r.reason, r.created_at, m.place, m.slug, p.name AS reporter
        FROM meet_reports r
        JOIN meets m ON m.id = r.meet_id
        JOIN meet_profiles p ON p.id = r.profile_id
        ORDER BY r.created_at DESC
        LIMIT 20
      `),
    ]);

    res.render('admin/ryadom', {
      totals: totals[0],
      recent: recent.map((row) => ({ ...row, activityInfo: getActivity(row.activity) })),
      reports,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/videos', async (req, res, next) => {
  try {
    const { title, youtube_url } = req.body;
    const youtubeId = extractYoutubeId(youtube_url);

    if (!youtubeId || !title || !title.trim()) {
      return res.redirect(
        '/admin?error=' + encodeURIComponent('Укажите название и корректную ссылку на YouTube-видео')
      );
    }

    const slug = nanoid(10);
    await pool.query(
      'INSERT INTO videos (slug, youtube_id, title) VALUES ($1, $2, $3)',
      [slug, youtubeId, title.trim()]
    );

    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.get('/videos/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM videos WHERE id = $1', [req.params.id]);
    const video = rows[0];
    if (!video) return res.status(404).render('404');

    const { rows: comments } = await pool.query(
      'SELECT * FROM comments WHERE video_id = $1 ORDER BY timestamp_seconds ASC',
      [video.id]
    );

    res.render('admin/video', {
      video,
      comments,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id/delete', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM videos WHERE id = $1', [req.params.id]);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.post('/comments/:id/resolve', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM comments WHERE id = $1', [req.params.id]);
    const comment = rows[0];
    if (!comment) return res.status(404).render('404');

    await pool.query('UPDATE comments SET resolved = $1 WHERE id = $2', [
      !comment.resolved,
      comment.id,
    ]);

    res.redirect(`/admin/videos/${comment.video_id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/reviewers', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (name) {
      await pool.query(
        'INSERT INTO reviewers (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [name]
      );
    }
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.post('/reviewers/:id/delete', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM reviewers WHERE id = $1', [req.params.id]);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
