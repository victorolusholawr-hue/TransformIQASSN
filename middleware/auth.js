'use strict';
const { getPool, sql } = require('../config/database');

async function _userExists(userId) {
  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, userId)
      .query('SELECT id FROM dbo.Users WHERE id = @id');
    return result.recordset.length > 0;
  } catch (_) {
    return true;
  }
}

function loginPath(req) {
  const target = req.originalUrl || req.url || '/dashboard';
  return `/login?next=${encodeURIComponent(target)}`;
}

function loginRequired(req, res, next) {
  if (!req.session.userId) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect(loginPath(req));
  }
  // Verify user still exists (guards against DB resets / deleted accounts)
  _userExists(req.session.userId).then(exists => {
    if (!exists) {
      const redirectTo = loginPath(req);
      return req.session.destroy(() => res.redirect(redirectTo));
    }
    next();
  }).catch(() => res.redirect(loginPath(req)));
}

function analystRequired(req, res, next) {
  loginRequired(req, res, () => {
    if (req.session.role === 'viewer') {
      req.flash('error', 'Analysts only.');
      return res.redirect('/dashboard');
    }
    next();
  });
}

function adminRequired(req, res, next) {
  loginRequired(req, res, () => {
    if (req.session.role !== 'admin') {
      req.flash('error', 'Admin access required.');
      return res.redirect('/dashboard');
    }
    next();
  });
}

module.exports = { loginRequired, analystRequired, adminRequired };
