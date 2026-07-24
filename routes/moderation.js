const express = require('express');
const { pool } = require('../db');

const router = express.Router();

async function loadVideo(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM videos WHERE slug = $1', [req.params.slug]);
    const video = rows[0];
    if (!video) return res.status(404).render('404');
    req.video = video;
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/moderate/:slug', loadVideo, async (req, res, next) => {
  try {
    const { rows: comments } = await pool.query(
      'SELECT * FROM comments WHERE video_id = $1 ORDER BY timestamp_seconds ASC',
      [req.video.id]
    );
    const { rows: reviewers } = await pool.query('SELECT * FROM reviewers ORDER BY name');

    res.render('moderate', {
      video: req.video,
      comments,
      reviewers,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/moderate/:slug/comments', loadVideo, async (req, res, next) => {
  try {
    const { reviewer_name, timestamp_seconds, text } = req.body;
    const seconds = Math.max(0, parseInt(timestamp_seconds, 10) || 0);
    const commentText = (text || '').trim();

    const { rows: reviewerRows } = await pool.query(
      'SELECT 1 FROM reviewers WHERE name = $1',
      [reviewer_name]
    );

    if (!reviewerRows.length || !commentText) {
      return res.redirect(
        `/moderate/${req.video.slug}?error=` +
          encodeURIComponent('Выберите проверяющего из списка и напишите текст правки')
      );
    }

    await pool.query(
      'INSERT INTO comments (video_id, reviewer_name, timestamp_seconds, text) VALUES ($1, $2, $3, $4)',
      [req.video.id, reviewer_name, seconds, commentText]
    );

    res.redirect(`/moderate/${req.video.slug}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
