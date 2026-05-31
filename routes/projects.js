'use strict';
const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { getPool, sql }       = require('../config/database');
const { loginRequired, analystRequired } = require('../middleware/auth');
const { projectAccessRequired }          = require('../middleware/projectAccess');
const router   = express.Router();

// ── List ────────────────────────────────────────────────────
router.get('/', loginRequired, async (req, res) => {
  res.redirect('/dashboard');
});

// ── Create ──────────────────────────────────────────────────
router.get('/create', analystRequired, (req, res) => {
  res.render('projects/create', { title: 'New Project' });
});

router.post('/create', analystRequired, async (req, res) => {
  const { name, description, tags } = req.body;
  if (!name || !name.trim()) {
    req.flash('error', 'Project name is required.');
    return res.redirect('/projects/create');
  }
  try {
    const pool = await getPool();
    const id   = uuidv4();
    const tagArr = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];

    await pool.request()
      .input('id',   sql.UniqueIdentifier, id)
      .input('name', sql.NVarChar,         name.trim())
      .input('desc', sql.NVarChar,         description || null)
      .input('oid',  sql.UniqueIdentifier, req.session.userId)
      .input('tags', sql.NVarChar,         JSON.stringify(tagArr))
      .query('INSERT INTO dbo.Projects (id, name, description, owner_id, tags) VALUES (@id, @name, @desc, @oid, @tags)');

    // Add owner as member
    await pool.request()
      .input('id',  sql.UniqueIdentifier, uuidv4())
      .input('pid', sql.UniqueIdentifier, id)
      .input('uid', sql.UniqueIdentifier, req.session.userId)
      .input('role',sql.NVarChar,         'owner')
      .query('INSERT INTO dbo.ProjectMembers (id, project_id, user_id, role) VALUES (@id, @pid, @uid, @role)');

    res.redirect(`/projects/${id}`);
  } catch (err) {
    console.error('[projects/create]', err);
    req.flash('error', 'Failed to create project.');
    res.redirect('/projects/create');
  }
});

// ── Detail ──────────────────────────────────────────────────
router.get('/:id', loginRequired, projectAccessRequired, async (req, res) => {
  try {
    const pool = await getPool();
    const pid  = req.params.id;

    const counts = {};
    for (const [key, table] of [
      ['requirements','Requirements'], ['stakeholders','Stakeholders'],
      ['processes','Processes'], ['decisions','Decisions'], ['risks','Risks'],
      ['business_rules','BusinessRules'], ['systems','Systems'], ['kpis','KPIs'],
      ['sources','Sources'],
    ]) {
      const r = await pool.request()
        .input('pid', sql.UniqueIdentifier, pid)
        .query(`SELECT COUNT(*) AS cnt FROM dbo.${table} WHERE project_id = @pid`);
      counts[key] = r.recordset[0].cnt;
    }

    const members = await pool.request()
      .input('pid', sql.UniqueIdentifier, pid)
      .query(`
        SELECT u.id, u.name, u.email, pm.role
        FROM   dbo.ProjectMembers pm
        JOIN   dbo.Users u ON u.id = pm.user_id
        WHERE  pm.project_id = @pid
      `);

    const recentSources = await pool.request()
      .input('pid', sql.UniqueIdentifier, pid)
      .query('SELECT TOP 5 * FROM dbo.Sources WHERE project_id=@pid ORDER BY created_at DESC');

    const sourceStatuses = await pool.request()
      .input('pid', sql.UniqueIdentifier, pid)
      .query(`
        SELECT ai_status, COUNT(*) AS cnt
        FROM dbo.Sources
        WHERE project_id=@pid
        GROUP BY ai_status
      `);
    const sourceStatusCounts = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const row of sourceStatuses.recordset) {
      sourceStatusCounts[row.ai_status || 'pending'] = row.cnt;
    }

    res.render('projects/detail', {
      title:   req.project.name,
      project: req.project,
      member:  req.projectMember,
      counts,
      members: members.recordset,
      recentSources: recentSources.recordset,
      sourceStatusCounts,
    });
  } catch (err) {
    console.error('[projects/detail]', err);
    req.flash('error', 'Failed to load project.');
    res.redirect('/dashboard');
  }
});

// ── Edit ────────────────────────────────────────────────────
router.get('/:id/edit', analystRequired, projectAccessRequired, (req, res) => {
  if (req.projectMember.role !== 'owner') {
    req.flash('error', 'Only the project owner can edit.');
    return res.redirect(`/projects/${req.params.id}`);
  }
  res.render('projects/edit', { title: 'Edit Project', project: req.project });
});

router.post('/:id/edit', analystRequired, projectAccessRequired, async (req, res) => {
  if (req.projectMember.role !== 'owner') {
    req.flash('error', 'Only the project owner can edit.');
    return res.redirect(`/projects/${req.params.id}`);
  }
  const { name, description, tags } = req.body;
  try {
    const pool   = await getPool();
    const tagArr = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    await pool.request()
      .input('id',   sql.UniqueIdentifier, req.params.id)
      .input('name', sql.NVarChar,         name || req.project.name)
      .input('desc', sql.NVarChar,         description || null)
      .input('tags', sql.NVarChar,         JSON.stringify(tagArr))
      .query('UPDATE dbo.Projects SET name=@name, description=@desc, tags=@tags WHERE id=@id');
    req.flash('success', 'Project updated.');
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    console.error('[projects/edit]', err);
    req.flash('error', 'Failed to update project.');
    res.redirect(`/projects/${req.params.id}/edit`);
  }
});

// ── Archive / Restore ────────────────────────────────────────
router.post('/:id/archive', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  await pool.request().input('id', sql.UniqueIdentifier, req.params.id)
    .query("UPDATE dbo.Projects SET status='archived' WHERE id=@id");
  req.flash('success', 'Project archived.');
  res.redirect('/dashboard');
});

router.post('/:id/restore', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  await pool.request().input('id', sql.UniqueIdentifier, req.params.id)
    .query("UPDATE dbo.Projects SET status='active' WHERE id=@id");
  req.flash('success', 'Project restored.');
  res.redirect(`/projects/${req.params.id}`);
});

// ── Delete ───────────────────────────────────────────────────
router.post('/:id/delete', analystRequired, projectAccessRequired, async (req, res) => {
  if (req.projectMember.role !== 'owner') {
    req.flash('error', 'Only the owner can delete a project.');
    return res.redirect(`/projects/${req.params.id}`);
  }
  const pool = await getPool();
  const pid  = req.params.id;
  // Cascade delete via FK relationships
  for (const t of ['GraphEdges','AIInsights','RoadmapTasks','Documents',
                    'Requirements','Stakeholders','Processes','Decisions',
                    'Risks','BusinessRules','Systems','KPIs','Sources',
                    'ProjectMembers','Projects']) {
    await pool.request().input('pid', sql.UniqueIdentifier, pid)
      .query(`DELETE FROM dbo.${t} WHERE ${t === 'Projects' ? 'id' : 'project_id'} = @pid`);
  }
  req.flash('success', 'Project deleted.');
  res.redirect('/dashboard');
});

// ── Members ──────────────────────────────────────────────────
router.post('/:id/members/invite', analystRequired, projectAccessRequired, async (req, res) => {
  if (req.projectMember.role !== 'owner') {
    req.flash('error', 'Only the owner can invite members.');
    return res.redirect(`/projects/${req.params.id}`);
  }
  const { email, role } = req.body;
  try {
    const pool = await getPool();
    const user = await pool.request()
      .input('email', sql.NVarChar, email.toLowerCase().trim())
      .query('SELECT id FROM dbo.Users WHERE email = @email');
    if (!user.recordset.length) {
      req.flash('error', 'No user found with that email.');
      return res.redirect(`/projects/${req.params.id}`);
    }
    const uid = user.recordset[0].id;
    await pool.request()
      .input('id',   sql.UniqueIdentifier, uuidv4())
      .input('pid',  sql.UniqueIdentifier, req.params.id)
      .input('uid',  sql.UniqueIdentifier, uid)
      .input('role', sql.NVarChar,         role || 'analyst')
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.ProjectMembers WHERE project_id=@pid AND user_id=@uid)
          INSERT INTO dbo.ProjectMembers (id, project_id, user_id, role) VALUES (@id, @pid, @uid, @role)
      `);
    req.flash('success', 'Member invited.');
  } catch (err) {
    console.error('[projects/invite]', err);
    req.flash('error', 'Failed to invite member.');
  }
  res.redirect(`/projects/${req.params.id}`);
});

router.post('/:id/members/:uid/remove', analystRequired, projectAccessRequired, async (req, res) => {
  if (req.projectMember.role !== 'owner') {
    req.flash('error', 'Only the owner can remove members.');
    return res.redirect(`/projects/${req.params.id}`);
  }
  const pool = await getPool();
  await pool.request()
    .input('pid', sql.UniqueIdentifier, req.params.id)
    .input('uid', sql.UniqueIdentifier, req.params.uid)
    .query('DELETE FROM dbo.ProjectMembers WHERE project_id=@pid AND user_id=@uid AND role != \'owner\'');
  req.flash('success', 'Member removed.');
  res.redirect(`/projects/${req.params.id}`);
});

module.exports = router;
