'use strict';
const express = require('express');
const { getPool, sql } = require('../config/database');
const { loginRequired } = require('../middleware/auth');
const { collectDataHealth } = require('../services/dataHealth');
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
    const health = await collectDataHealth(pool);
    const dataHealthWarnings = [];
    if (health.sourceFilesWithoutRows.length && projects.some(p => Number(p.source_count || 0) === 0)) {
      dataHealthWarnings.push(`${health.sourceFilesWithoutRows.length} uploaded source file(s) are not linked to a project record.`);
    }
    if (health.orphanedProjects.length || health.missingOwnerMemberships.length) {
      dataHealthWarnings.push('Some projects have missing membership records and may be hidden from users.');
    }
    res.render('dashboard/home', { title: 'Dashboard', projects, dataHealthWarnings });
  } catch (err) {
    console.error('[dashboard]', err);
    req.flash('error', 'Failed to load dashboard.');
    res.redirect('/login');
  }
});

module.exports = router;
