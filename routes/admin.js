'use strict';
const express = require('express');
const { getPool, sql } = require('../config/database');
const { adminRequired } = require('../middleware/auth');
const { collectDataHealth } = require('../services/dataHealth');
const router = express.Router();


router.get('/data-health', adminRequired, async (req, res) => {
  try {
    const health = await collectDataHealth();
    res.render('admin/data_health', { title: 'Data Health', health });
  } catch (err) {
    console.error('[admin/data-health]', err);
    req.flash('error', 'Failed to load data health report.');
    res.redirect('/dashboard');
  }
});

router.get('/usage', adminRequired, async (req, res) => {
  try {
    const pool  = await getPool();
    const month = new Date().toISOString().slice(0, 7);

    const monthly = await pool.request()
      .input('k', sql.NVarChar, month)
      .query('SELECT * FROM dbo.UsageStats WHERE stat_key = @k');

    const perProject = await pool.request()
      .input('prefix', sql.NVarChar, `${month}|proj|%`)
      .query(`
        SELECT us.stat_key, us.input_tokens, us.output_tokens, us.calls,
               p.name AS project_name
        FROM   dbo.UsageStats us
        LEFT JOIN dbo.Projects p ON us.stat_key LIKE '%|proj|' + CAST(p.id AS NVARCHAR(36))
        WHERE  us.stat_key LIKE @prefix
        ORDER  BY us.calls DESC
      `);

    const settings = await pool.request()
      .input('k', sql.NVarChar, 'ai_limits')
      .query('SELECT setting_value FROM dbo.AppSettings WHERE setting_key = @k');

    const aiSettings = settings.recordset.length
      ? JSON.parse(settings.recordset[0].setting_value)
      : {};

    res.render('admin/usage', {
      title:       'Usage Dashboard',
      monthly:     monthly.recordset[0] || {},
      perProject:  perProject.recordset,
      aiSettings,
      currentMonth: month,
    });
  } catch (err) {
    console.error('[admin/usage]', err);
    req.flash('error', 'Failed to load usage stats.');
    res.redirect('/dashboard');
  }
});

router.post('/usage', adminRequired, async (req, res) => {
  try {
    const pool = await getPool();
    const settings = {
      rate_limit_enabled:               req.body.rate_limit_enabled === 'on',
      max_insight_per_user_per_hour:    parseInt(req.body.max_insight_per_user_per_hour  || '10',  10),
      max_extract_per_user_per_hour:    parseInt(req.body.max_extract_per_user_per_hour  || '20',  10),
      max_insight_per_project_per_hour: parseInt(req.body.max_insight_per_project_per_hour || '20', 10),
      max_extract_per_project_per_hour: parseInt(req.body.max_extract_per_project_per_hour || '40', 10),
      budget_enabled:                   req.body.budget_enabled === 'on',
      max_monthly_tokens:               parseInt(req.body.max_monthly_tokens || '1000000', 10),
    };
    await pool.request()
      .input('k', sql.NVarChar, 'ai_limits')
      .input('v', sql.NVarChar, JSON.stringify(settings))
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.AppSettings WHERE setting_key = @k)
          UPDATE dbo.AppSettings SET setting_value = @v WHERE setting_key = @k
        ELSE
          INSERT INTO dbo.AppSettings (setting_key, setting_value) VALUES (@k, @v)
      `);
    req.flash('success', 'Settings updated.');
  } catch (err) {
    console.error('[admin/usage POST]', err);
    req.flash('error', 'Failed to update settings.');
  }
  res.redirect('/admin/usage');
});

module.exports = router;
