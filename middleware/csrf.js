'use strict';
const crypto = require('crypto');

function csrfMiddleware(req, res, next) {
  // Generate token for this session if not already set
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  // Validate on state-changing methods
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const token = req.body && req.body._csrf;
    // Allow JSON API calls from same session (AJAX endpoints send token in body too)
    if (token !== req.session.csrfToken) {
      res.status(403).send('Invalid CSRF token');
      return;
    }
  }
  next();
}

module.exports = csrfMiddleware;
