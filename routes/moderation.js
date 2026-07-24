const express = require('express');
const db = require('../db');

const router = express.Router();

function loadVideo(req, res, next) {
  const video = db.prepare('SELECT * FROM videos WHERE slug = ?').get(req.params.slug);
  if (!video) return res.status(404).render('404');
  req.video = video;
  next();
}

router.get('/moderate/:slug', loadVideo, (req, res) => {
  const comments = db
    .prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY timestamp_seconds ASC')
    .all(req.video.id);
  const reviewers = db.prepare('SELECT * FROM reviewers ORDER BY name').all();

  res.render('moderate', {
    video: req.video,
    comments,
    reviewers,
    error: req.query.error || null,
  });
});

router.post('/moderate/:slug/comments', loadVideo, (req, res) => {
  const { reviewer_name, timestamp_seconds, text } = req.body;
  const seconds = Math.max(0, parseInt(timestamp_seconds, 10) || 0);
  const commentText = (text || '').trim();

  const reviewerExists = db
    .prepare('SELECT 1 FROM reviewers WHERE name = ?')
    .get(reviewer_name);

  if (!reviewerExists || !commentText) {
    return res.redirect(
      `/moderate/${req.video.slug}?error=` +
        encodeURIComponent('Выберите проверяющего из списка и напишите текст правки')
    );
  }

  db.prepare(
    'INSERT INTO comments (video_id, reviewer_name, timestamp_seconds, text) VALUES (?, ?, ?, ?)'
  ).run(req.video.id, reviewer_name, seconds, commentText);

  res.redirect(`/moderate/${req.video.slug}`);
});

module.exports = router;
