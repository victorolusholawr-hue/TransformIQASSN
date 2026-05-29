'use strict';
const { getPool, sql } = require('../config/database');

/**
 * Verifies that the logged-in user is a member of req.params.projectId.
 * Attaches req.project and req.projectMember on success.
 * Must be used after loginRequired.
 */
async function projectAccessRequired(req, res, next) {
  const projectId = req.params.projectId || req.params.id;
  if (!projectId) return res.status(404).send('Project not found');

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('project_id', sql.UniqueIdentifier, projectId)
      .input('user_id',    sql.UniqueIdentifier, req.session.userId)
      .query(`
        SELECT p.id, p.name, p.description, p.owner_id, p.status,
               pm.role AS member_role
        FROM   dbo.Projects p
        JOIN   dbo.ProjectMembers pm
               ON pm.project_id = p.id AND pm.user_id = @user_id
        WHERE  p.id = @project_id
      `);

    if (result.recordset.length === 0) {
      req.flash('error', 'Project not found or access denied.');
      return res.redirect('/dashboard');
    }

    const row        = result.recordset[0];
    req.project      = row;
    req.projectMember = { role: row.member_role };
    next();
  } catch (err) {
    console.error('[projectAccess]', err);
    res.status(500).send('Server error');
  }
}

module.exports = { projectAccessRequired };
