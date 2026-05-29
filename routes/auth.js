'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getPool, sql } = require('../config/database');
const router   = express.Router();

router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Login' });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    req.flash('error', 'Email and password are required.');
    return res.redirect('/login');
  }
  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('email', sql.NVarChar, email.toLowerCase().trim())
      .query('SELECT id, name, email, password_hash, role FROM dbo.Users WHERE email = @email');

    const user = result.recordset[0];
    if (!user || !user.password_hash) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/login');
    }
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/login');
    }
    req.session.userId = user.id;
    req.session.name   = user.name;
    req.session.role   = user.role;
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[auth/login]', err);
    req.flash('error', 'Server error. Please try again.');
    res.redirect('/login');
  }
});

router.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('auth/register', { title: 'Register' });
});

router.post('/register', async (req, res) => {
  const { name, email, password, confirm_password } = req.body;
  if (!name || !email || !password) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/register');
  }
  if (password !== confirm_password) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect('/register');
  }
  if (password.length < 8) {
    req.flash('error', 'Password must be at least 8 characters.');
    return res.redirect('/register');
  }
  try {
    const pool  = await getPool();
    const check = await pool.request()
      .input('email', sql.NVarChar, email.toLowerCase().trim())
      .query('SELECT id FROM dbo.Users WHERE email = @email');
    if (check.recordset.length) {
      req.flash('error', 'An account with that email already exists.');
      return res.redirect('/register');
    }
    const hash = await bcrypt.hash(password, 12);
    const id   = uuidv4();
    await pool.request()
      .input('id',   sql.UniqueIdentifier, id)
      .input('name', sql.NVarChar,         name.trim())
      .input('email',sql.NVarChar,         email.toLowerCase().trim())
      .input('hash', sql.NVarChar,         hash)
      .query('INSERT INTO dbo.Users (id, name, email, password_hash) VALUES (@id, @name, @email, @hash)');

    req.session.userId = id;
    req.session.name   = name.trim();
    req.session.role   = 'analyst';
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[auth/register]', err);
    req.flash('error', 'Server error. Please try again.');
    res.redirect('/register');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
