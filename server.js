require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');

const { init: initDb } = require('./db');
const adminRoutes = require('./routes/admin');
const moderationRoutes = require('./routes/moderation');
const meetRoutes = require('./routes/meet');

const app = express();

// На Render (и за любым обратным прокси) без этого req.secure всегда false
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
  })
);

app.use('/', moderationRoutes);
app.use('/admin', adminRoutes);
app.use('/ryadom', meetRoutes);

app.get('/', (req, res) => res.redirect('/ryadom'));

app.use((req, res) => {
  res.status(404).render('404');
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`poPromtu running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Не удалось инициализировать базу данных:', err);
    process.exit(1);
  });
