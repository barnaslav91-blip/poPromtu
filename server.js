require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');

const adminRoutes = require('./routes/admin');
const moderationRoutes = require('./routes/moderation');

const app = express();

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

app.get('/', (req, res) => res.redirect('/admin'));

app.use((req, res) => {
  res.status(404).render('404');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`poPromtu running on http://localhost:${PORT}`);
});
