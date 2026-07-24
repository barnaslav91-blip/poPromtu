const express = require('express');
const { nanoid } = require('nanoid');

const db = require('../db');
const { extractYoutubeId } = require('../lib/youtube');

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

router.get('/', (req, res) => {
  const videos = db
    .prepare(
      `SELECT v.*,
        (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS total_comments,
        (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.resolved = 0) AS open_comments
       FROM videos v ORDER BY v.created_at DESC`
    )
    .all();
  const reviewers = db.prepare('SELECT * FROM reviewers ORDER BY name').all();

  res.render('admin/dashboard', {
    videos,
    reviewers,
    error: req.query.error || null,
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
});

router.post('/videos', (req, res) => {
  const { title, youtube_url } = req.body;
  const youtubeId = extractYoutubeId(youtube_url);

  if (!youtubeId || !title || !title.trim()) {
    return res.redirect('/admin?error=' + encodeURIComponent('Укажите название и корректную ссылку на YouTube-видео'));
  }

  const slug = nanoid(10);
  db.prepare('INSERT INTO videos (slug, youtube_id, title) VALUES (?, ?, ?)').run(
    slug,
    youtubeId,
    title.trim()
  );

  res.redirect('/admin');
});

router.get('/videos/:id', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).render('404');

  const comments = db
    .prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY timestamp_seconds ASC')
    .all(video.id);

  res.render('admin/video', {
    video,
    comments,
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
});

router.post('/videos/:id/delete', (req, res) => {
  db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

router.post('/comments/:id/resolve', (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).render('404');

  db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(
    comment.resolved ? 0 : 1,
    comment.id
  );

  res.redirect(`/admin/videos/${comment.video_id}`);
});

router.post('/reviewers', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    try {
      db.prepare('INSERT INTO reviewers (name) VALUES (?)').run(name);
    } catch {
      // уже существует — игнорируем
    }
  }
  res.redirect('/admin');
});

router.post('/reviewers/:id/delete', (req, res) => {
  db.prepare('DELETE FROM reviewers WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

module.exports = router;
