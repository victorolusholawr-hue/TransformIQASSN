'use strict';
require('dotenv').config();

const path    = require('path');
const express = require('express');
const session = require('express-session');
const flash   = require('connect-flash');
const layouts = require('express-ejs-layouts');
const helmet  = require('helmet');
const morgan  = require('morgan');

const { initDb }      = require('./db/init');
const csrfMiddleware  = require('./middleware/csrf');

// ── Routes ──────────────────────────────────────────────────
const authRoutes       = require('./routes/auth');
const dashboardRoutes  = require('./routes/dashboard');
const adminRoutes      = require('./routes/admin');
const projectRoutes    = require('./routes/projects');
const sourceRoutes     = require('./routes/sources');
const entityRoutes     = require('./routes/entities');
const graphRoutes      = require('./routes/graph');
const visualizeRoutes  = require('./routes/visualize');
const insightRoutes    = require('./routes/insights');
const exportRoutes     = require('./routes/export');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'cdn.jsdelivr.net'],
      fontSrc:    ["'self'", 'fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
    },
  },
}));

// ── Logging ──────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Body parsing ─────────────────────────────────────────────
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.json({ limit: '100mb' }));

// ── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Session ──────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ── Flash messages ───────────────────────────────────────────
app.use(flash());

// ── CSRF protection ──────────────────────────────────────────
app.use(csrfMiddleware);

// ── View engine ──────────────────────────────────────────────
app.use(layouts);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.set('layout extractScripts', true);
app.set('layout extractStyles', true);

// ── Global template locals ───────────────────────────────────
app.use((req, res, next) => {
  res.locals.flash        = req.flash();
  res.locals.session      = req.session;
  res.locals.currentUser  = req.session.userId ? {
    id:   req.session.userId,
    name: req.session.name,
    role: req.session.role,
  } : null;
  next();
});

// ── Routes ───────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect(req.session.userId ? '/dashboard' : '/login'));

app.use('/',            authRoutes);
app.use('/dashboard',   dashboardRoutes);
app.use('/admin',       adminRoutes);
app.use('/projects',    projectRoutes);
app.use('/',            sourceRoutes);
app.use('/',            entityRoutes);
app.use('/',            graphRoutes);
app.use('/',            visualizeRoutes);
app.use('/',            insightRoutes);
app.use('/',            exportRoutes);

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', { title: '404', message: 'Page not found' });
});

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[app]', err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong.' });
});

// ── Start ────────────────────────────────────────────────────
async function start() {
  try {
    await initDb();
    app.listen(PORT, () => console.log(`[app] TransformIQ running at http://localhost:${PORT}`));
  } catch (err) {
    console.error('[app] Failed to start:', err);
    process.exit(1);
  }
}

start();
