'use strict';
const express = require('express');
const { getPool, sql } = require('../config/database');
const { loginRequired } = require('../middleware/auth');
const router = express.Router();

router.get('/', loginRequired, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('uid', sql.UniqueIdentifier, req.session.userId)
      .query(`
        SELECT DISTINCT p.id, p.name, p.description, p.status, p.created_at,
               pm.role AS member_role,
               (SELECT COUNT(*) FROM dbo.Sources s WHERE s.project_id = p.id)      AS source_count,
               (SELECT COUNT(*) FROM dbo.Requirements r WHERE r.project_id = p.id) AS req_count
        FROM   dbo.Projects p
        JOIN   dbo.ProjectMembers pm ON pm.project_id = p.id AND pm.user_id = @uid
        ORDER BY p.created_at DESC
      `);

    const projects = result.recordset;
    res.render('dashboard/home', { title: 'Dashboard', projects });
  } catch (err) {
    console.error('[dashboard]', err);
    req.flash('error', 'Failed to load dashboard.');
    res.redirect('/login');
  }
});

module.exports = router;
