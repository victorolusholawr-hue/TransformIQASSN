'use strict';
const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getPool, sql }       = require('../config/database');
const { loginRequired, analystRequired } = require('../middleware/auth');
const { projectAccessRequired }          = require('../middleware/projectAccess');
const { reconcileProjectSourceStatuses } = require('../services/sourceStatus');
const router   = express.Router();

const BUNDLE_FORMAT  = 'tiq-project-bundle';
const BUNDLE_VERSION = '1';

const ENTITY_EXPORT_SPECS = [
  { key: 'requirements',   table: 'Requirements',  cols: 'id,source_id,req_type,title,description,priority,status,confidence,source_quote' },
  { key: 'stakeholders',   table: 'Stakeholders',  cols: 'id,source_id,name,role,organization,influence,interest,confidence,source_quote' },
  { key: 'processes',      table: 'Processes',     cols: 'id,source_id,name,description,steps,mermaid_syntax,confidence,source_quote' },
  { key: 'decisions',      table: 'Decisions',     cols: 'id,source_id,title,description,rationale,decision_maker,status,confidence,source_quote' },
  { key: 'risks',          table: 'Risks',         cols: 'id,source_id,title,description,category,likelihood,impact,mitigation,owner,confidence,source_quote' },
  { key: 'business_rules', table: 'BusinessRules', cols: 'id,source_id,title,description,category,confidence,source_quote' },
  { key: 'systems',        table: 'Systems',       cols: 'id,source_id,name,system_type,description,integrations,confidence,source_quote' },
  { key: 'kpis',           table: 'KPIs',          cols: 'id,source_id,name,description,target_value,measurement_method,frequency,owner,confidence,source_quote' },
];

const uploadBundle = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── List ────────────────────────────────────────────────────
router.get('/', loginRequired, async (req, res) => {
  res.redirect('/dashboard');
});

// ── Import ──────────────────────────────────────────────────
router.get('/import', analystRequired, (req, res) => {
  res.render('projects/import', { title: 'Import Project' });
});

router.post('/import', analystRequired, uploadBundle.single('bundle'), async (req, res) => {
  if (!req.file) {
    req.flash('error', 'Please select a .tiq.json bundle file.');
    return res.redirect('/projects/import');
  }

  let bundle;
  try {
    bundle = JSON.parse(req.file.buffer.toString('utf8'));
  } catch (_) {
    req.flash('error', 'Invalid file — could not parse JSON.');
    return res.redirect('/projects/import');
  }

  if (bundle.format !== BUNDLE_FORMAT) {
    req.flash('error', 'Unrecognised file format. Export the project from a TransformIQ Association instance first.');
    return res.redirect('/projects/import');
  }

  try {
    const pool   = await getPool();
    const pid    = uuidv4();
    const proj   = bundle.project || {};
    const tagArr = Array.isArray(proj.tags) ? proj.tags : [];

    await pool.request()
      .input('id',   sql.UniqueIdentifier, pid)
      .input('name', sql.NVarChar,         (proj.name || 'Imported Project').trim())
      .input('desc', sql.NVarChar,         proj.description || null)
      .input('oid',  sql.UniqueIdentifier, req.session.userId)
      .input('tags', sql.NVarChar,         JSON.stringify(tagArr))
      .query('INSERT INTO dbo.Projects (id, name, description, owner_id, tags) VALUES (@id, @name, @desc, @oid, @tags)');

    await pool.request()
      .input('id',   sql.UniqueIdentifier, uuidv4())
      .input('pid',  sql.UniqueIdentifier, pid)
      .input('uid',  sql.UniqueIdentifier, req.session.userId)
      .input('role', sql.NVarChar,         'owner')
      .query('INSERT INTO dbo.ProjectMembers (id, project_id, user_id, role) VALUES (@id, @pid, @uid, @role)');

    // Sources — remap IDs; carry extracted_text so no re-extraction needed
    const sourceIdMap = {};
    const counts = { sources: 0, entities: 0, insights: 0, roadmap_tasks: 0 };

    for (const src of (bundle.sources || [])) {
      const newId = uuidv4();
      sourceIdMap[src.id] = newId;
      const aiStatus = src.extraction_status === 'done' ? 'done' : 'pending';
      await pool.request()
        .input('id',        sql.UniqueIdentifier, newId)
        .input('pid',       sql.UniqueIdentifier, pid)
        .input('name',      sql.NVarChar,         src.name || 'Imported source')
        .input('stype',     sql.NVarChar,         src.source_type || 'document')
        .input('furl',      sql.NVarChar,         null)
        .input('fext',      sql.NVarChar,         src.file_ext || null)
        .input('text',      sql.NVarChar,         src.extracted_text || null)
        .input('estatus',   sql.NVarChar,         src.extraction_status || 'done')
        .input('astatus',   sql.NVarChar,         aiStatus)
        .input('parts',     sql.NVarChar,         src.participants || '[]')
        .input('meta',      sql.NVarChar,         src.metadata || '{}')
        .query(`INSERT INTO dbo.Sources
                  (id, project_id, name, source_type, file_url, file_ext, extracted_text, extraction_status, ai_status, participants, metadata)
                VALUES (@id, @pid, @name, @stype, @furl, @fext, @text, @estatus, @astatus, @parts, @meta)`);
      counts.sources++;
    }

    // Entities — remap IDs and source_ids
    for (const spec of ENTITY_EXPORT_SPECS) {
      const rows = (bundle.entities || {})[spec.key] || [];
      for (const row of rows) {
        const newId  = uuidv4();
        const newSrc = row.source_id ? (sourceIdMap[row.source_id] || null) : null;
        const cols   = spec.cols.split(',').filter(c => c !== 'id' && c !== 'source_id');

        const req2 = pool.request()
          .input('id',  sql.UniqueIdentifier, newId)
          .input('pid', sql.UniqueIdentifier, pid)
          .input('sid', sql.UniqueIdentifier, newSrc);

        const setCols = ['id', 'project_id', 'source_id'];
        const setVals = ['@id', '@pid', '@sid'];

        for (const col of cols) {
          let val = row[col];
          if (val !== undefined && val !== null) {
            if (typeof val === 'object') val = JSON.stringify(val);
            req2.input(col, sql.NVarChar, String(val));
          } else {
            req2.input(col, sql.NVarChar, null);
          }
          setCols.push(col);
          setVals.push(`@${col}`);
        }

        await req2.query(
          `INSERT INTO dbo.${spec.table} (${setCols.join(',')}) VALUES (${setVals.join(',')})`
        );
        counts.entities++;
      }
    }

    // AI Insights
    for (const insight of (bundle.ai_insights || [])) {
      await pool.request()
        .input('id',   sql.UniqueIdentifier, uuidv4())
        .input('pid',  sql.UniqueIdentifier, pid)
        .input('type', sql.NVarChar,         insight.type)
        .input('content', sql.NVarChar,      typeof insight.content === 'string' ? insight.content : JSON.stringify(insight.content))
        .input('gen', sql.NVarChar,          insight.generated_by || 'import')
        .query(`IF NOT EXISTS (SELECT 1 FROM dbo.AIInsights WHERE project_id=@pid AND type=@type)
                  INSERT INTO dbo.AIInsights (id, project_id, type, content, generated_by) VALUES (@id, @pid, @type, @content, @gen)`);
      counts.insights++;
    }

    // Roadmap tasks
    for (const task of (bundle.roadmap_tasks || [])) {
      await pool.request()
        .input('id',         sql.UniqueIdentifier, uuidv4())
        .input('pid',        sql.UniqueIdentifier, pid)
        .input('phase',      sql.NVarChar,         task.phase_name || '')
        .input('title',      sql.NVarChar,         task.req_title || '')
        .input('status',     sql.NVarChar,         task.status || 'pending')
        .input('owner',      sql.NVarChar,         task.owner || null)
        .input('due_date',   sql.NVarChar,         task.due_date || null)
        .input('notes',      sql.NVarChar,         task.notes || null)
        .input('sort_order', sql.Int,              task.sort_order || 0)
        .query(`INSERT INTO dbo.RoadmapTasks (id, project_id, phase_name, req_title, status, owner, due_date, notes, sort_order)
                VALUES (@id, @pid, @phase, @title, @status, @owner, @due_date, @notes, @sort_order)`);
      counts.roadmap_tasks++;
    }

    req.flash('success',
      `Project "${proj.name || 'Imported'}" imported successfully — ` +
      `${counts.sources} sources, ${counts.entities} entities, ${counts.insights} insights, ${counts.roadmap_tasks} roadmap tasks.`
    );
    res.redirect(`/projects/${pid}`);
  } catch (err) {
    console.error('[projects/import]', err);
    req.flash('error', 'Import failed: ' + (err.message || 'Unknown error'));
    res.redirect('/projects/import');
  }
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
    await reconcileProjectSourceStatuses(pool, pid);

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

// ── Export Bundle ────────────────────────────────────────────
router.get('/:id/export/bundle', analystRequired, projectAccessRequired, async (req, res) => {
  try {
    const pool = await getPool();
    const pid  = req.params.id;

    const proj = req.project;

    const sources = await pool.request()
      .input('pid', sql.UniqueIdentifier, pid)
      .query('SELECT id, name, source_type, file_ext, extracted_text, extraction_status, participants, metadata FROM dbo.Sources WHERE project_id=@pid ORDER BY created_at');

    const entities = {};
    for (const spec of ENTITY_EXPORT_SPECS) {
      const result = await pool.request()
        .input('pid', sql.UniqueIdentifier, pid)
        .query(`SELECT ${spec.cols} FROM dbo.${spec.table} WHERE project_id=@pid ORDER BY created_at`);
      entities[spec.key] = result.recordset;
    }

    const insights = await pool.request()
      .input('pid', sql.UniqueIdentifier, pid)
      .query('SELECT type, content, generated_by, generated_at FROM dbo.AIInsights WHERE project_id=@pid');

    const tasks = await pool.request()
      .input('pid', sql.UniqueIdentifier, pid)
      .query('SELECT phase_name, req_title, status, owner, due_date, notes, sort_order FROM dbo.RoadmapTasks WHERE project_id=@pid ORDER BY sort_order');

    const bundle = {
      format:      BUNDLE_FORMAT,
      version:     BUNDLE_VERSION,
      exported_at: new Date().toISOString(),
      project: {
        name:        proj.name,
        description: proj.description,
        tags:        Array.isArray(proj.tags) ? proj.tags : [],
        status:      proj.status,
      },
      sources:      sources.recordset,
      entities,
      ai_insights:  insights.recordset,
      roadmap_tasks: tasks.recordset,
    };

    const slug     = (proj.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const datePart = new Date().toISOString().slice(0, 10);
    const filename = `${slug}-${datePart}.tiq.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(bundle, null, 2));
  } catch (err) {
    console.error('[projects/export-bundle]', err);
    req.flash('error', 'Failed to export project bundle.');
    res.redirect(`/projects/${req.params.id}`);
  }
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
