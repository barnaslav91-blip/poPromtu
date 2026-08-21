const express = require('express');
const { nanoid } = require('nanoid');

const { pool } = require('../db');
const { extractYoutubeId } = require('../lib/youtube');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

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
