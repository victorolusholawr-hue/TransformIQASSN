'use strict';
const express = require('express');
const { getPool, sql }           = require('../config/database');
const { loginRequired, analystRequired } = require('../middleware/auth');
const { projectAccessRequired }          = require('../middleware/projectAccess');
const router  = express.Router();

const ENTITY_MAP = {
  requirements:   { table: 'Requirements',   nameCol: 'title',  hasStatus: true  },
  stakeholders:   { table: 'Stakeholders',   nameCol: 'name',   hasStatus: false },
  processes:      { table: 'Processes',      nameCol: 'name',   hasStatus: false },
  decisions:      { table: 'Decisions',      nameCol: 'title',  hasStatus: true  },
  risks:          { table: 'Risks',          nameCol: 'title',  hasStatus: false },
  business_rules: { table: 'BusinessRules',  nameCol: 'title',  hasStatus: false },
  systems:        { table: 'Systems',        nameCol: 'name',   hasStatus: false },
  kpis:           { table: 'KPIs',           nameCol: 'name',   hasStatus: false },
};

// ── List ─────────────────────────────────────────────────────
router.get('/projects/:projectId/:type(requirements|stakeholders|processes|decisions|risks|business_rules|systems|kpis)',
  loginRequired, projectAccessRequired,
  async (req, res) => {
    const { type, projectId } = req.params;
    const { table } = ENTITY_MAP[type];
    const { priority, status, confidence_min, req_type } = req.query;

    try {
      const pool    = await getPool();
      let query  = `SELECT * FROM dbo.${table} WHERE project_id = @pid`;
      const req2 = pool.request().input('pid', sql.UniqueIdentifier, projectId);

      if (priority) { query += ' AND priority = @priority'; req2.input('priority', sql.NVarChar, priority); }
      if (status)   { query += ' AND status = @status';     req2.input('status',   sql.NVarChar, status);   }
      if (req_type) { query += ' AND req_type = @rtype';    req2.input('rtype',    sql.NVarChar, req_type); }
      if (confidence_min) {
        query += ' AND confidence >= @cmin';
        req2.input('cmin', sql.Decimal(3,2), parseFloat(confidence_min));
      }
      query += ' ORDER BY created_at DESC';

      const result = await req2.query(query);
      res.render(`entities/${type}`, {
        title:    type.replace(/_/g, ' '),
        project:  req.project,
        member:   req.projectMember,
        entities: result.recordset,
        filters:  req.query,
      });
    } catch (err) {
      console.error(`[entities/${type}]`, err);
      req.flash('error', 'Failed to load entities.');
      res.redirect(`/projects/${projectId}`);
    }
  }
);

// ── Detail ───────────────────────────────────────────────────
router.get('/projects/:projectId/:type(requirements|stakeholders|processes|decisions|risks|business_rules|systems|kpis)/:eid',
  loginRequired, projectAccessRequired,
  async (req, res) => {
    const { type, eid, projectId } = req.params;
    const { table } = ENTITY_MAP[type];
    const pool   = await getPool();
    const result = await pool.request()
      .input('id',  sql.UniqueIdentifier, eid)
      .input('pid', sql.UniqueIdentifier, projectId)
      .query(`SELECT * FROM dbo.${table} WHERE id=@id AND project_id=@pid`);
    const entity = result.recordset[0];
    if (!entity) return res.status(404).render('error', { title: '404', message: 'Entity not found' });

    // Parse JSON fields
    if (entity.steps)        try { entity.steps        = JSON.parse(entity.steps); } catch(_){}
    if (entity.integrations) try { entity.integrations = JSON.parse(entity.integrations); } catch(_){}

    const viewName = type === 'requirements' ? 'entities/requirement_detail' : `entities/${type.slice(0, -1)}_detail`;
    // fallback to generic
    res.render('entities/detail', {
      title:   entity.title || entity.name,
      project: req.project,
      entity,
      type,
    });
  }
);

// ── Edit ─────────────────────────────────────────────────────
router.post('/projects/:projectId/:type(requirements|stakeholders|processes|decisions|risks|business_rules|systems|kpis)/:eid/edit',
  analystRequired, projectAccessRequired,
  async (req, res) => {
    const { type, eid, projectId } = req.params;
    const { table } = ENTITY_MAP[type];
    const body = req.body;
    try {
      const pool  = await getPool();
      const sets  = [];
      const r     = pool.request()
        .input('id',  sql.UniqueIdentifier, eid)
        .input('pid', sql.UniqueIdentifier, projectId);

      const fieldMap = {
        requirements:   ['title','description','req_type','priority','status'],
        stakeholders:   ['name','role','organization','influence','interest'],
        processes:      ['name','description','mermaid_syntax'],
        decisions:      ['title','description','rationale','decision_maker','status'],
        risks:          ['title','description','category','likelihood','impact','mitigation','owner'],
        business_rules: ['title','description','category'],
        systems:        ['name','system_type','description'],
        kpis:           ['name','description','target_value','measurement_method','frequency','owner'],
      };

      for (const f of fieldMap[type] || []) {
        if (body[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          r.input(f, sql.NVarChar, String(body[f]));
        }
      }
      if (!sets.length) { req.flash('error', 'Nothing to update.'); return res.redirect('back'); }

      await r.query(`UPDATE dbo.${table} SET ${sets.join(', ')} WHERE id=@id AND project_id=@pid`);
      req.flash('success', 'Updated.');
      res.redirect(`/projects/${projectId}/${type}`);
    } catch (err) {
      console.error(`[entities/edit]`, err);
      req.flash('error', 'Update failed.');
      res.redirect('back');
    }
  }
);

// ── Delete ───────────────────────────────────────────────────
router.post('/projects/:projectId/:type(requirements|stakeholders|processes|decisions|risks|business_rules|systems|kpis)/:eid/delete',
  analystRequired, projectAccessRequired,
  async (req, res) => {
    const { type, eid, projectId } = req.params;
    const { table } = ENTITY_MAP[type];
    const pool = await getPool();
    await pool.request()
      .input('id',  sql.UniqueIdentifier, eid)
      .input('pid', sql.UniqueIdentifier, projectId)
      .query(`DELETE FROM dbo.${table} WHERE id=@id AND project_id=@pid`);
    req.flash('success', 'Deleted.');
    res.redirect(`/projects/${projectId}/${type}`);
  }
);

// ── Requirements: confirm / reject / bulk ────────────────────
router.post('/projects/:projectId/requirements/:eid/confirm', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, req.params.eid)
    .query("UPDATE dbo.Requirements SET status='confirmed' WHERE id=@id");
  res.redirect(`/projects/${req.params.projectId}/requirements`);
});

router.post('/projects/:projectId/requirements/:eid/reject', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, req.params.eid)
    .query("UPDATE dbo.Requirements SET status='rejected' WHERE id=@id");
  res.redirect(`/projects/${req.params.projectId}/requirements`);
});

router.post('/projects/:projectId/requirements/bulk-action', analystRequired, projectAccessRequired, async (req, res) => {
  const { action, ids } = req.body;
  const idList = Array.isArray(ids) ? ids : [ids];
  if (!idList.length) { return res.redirect(`/projects/${req.params.projectId}/requirements`); }
  const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
  const pool = await getPool();
  for (const id of idList) {
    await pool.request()
      .input('id',  sql.UniqueIdentifier, id)
      .input('st',  sql.NVarChar, newStatus)
      .query('UPDATE dbo.Requirements SET status=@st WHERE id=@id');
  }
  req.flash('success', `${idList.length} requirements ${newStatus}.`);
  res.redirect(`/projects/${req.params.projectId}/requirements`);
});

// ── Stakeholders: merge ──────────────────────────────────────
router.post('/projects/:projectId/stakeholders/:eid/merge', analystRequired, projectAccessRequired, async (req, res) => {
  const { target_id } = req.body;
  if (!target_id) { return res.redirect(`/projects/${req.params.projectId}/stakeholders`); }
  const pool = await getPool();
  // Point source's entities to target, then delete source
  await pool.request()
    .input('old', sql.UniqueIdentifier, req.params.eid)
    .input('new', sql.UniqueIdentifier, target_id)
    .query("DELETE FROM dbo.Stakeholders WHERE id=@old");
  req.flash('success', 'Stakeholders merged.');
  res.redirect(`/projects/${req.params.projectId}/stakeholders`);
});

// ── JSON API: inline edit ────────────────────────────────────
router.post('/api/entities/:type/:id/update', analystRequired, async (req, res) => {
  const { type, id } = req.params;
  const info = ENTITY_MAP[type];
  if (!info) return res.status(400).json({ ok: false });

  try {
    const pool  = await getPool();
    const body  = req.body;
    const sets  = [];
    const r     = pool.request().input('id', sql.UniqueIdentifier, id);
    const allowed = ['title','name','description','status','priority','req_type',
                     'role','organization','influence','interest',
                     'category','likelihood','impact','mitigation','owner',
                     'decision_maker','rationale','system_type',
                     'target_value','measurement_method','frequency'];
    for (const f of allowed) {
      if (body[f] !== undefined) { sets.push(`${f}=@${f}`); r.input(f, sql.NVarChar, String(body[f])); }
    }
    if (!sets.length) return res.json({ ok: false, error: 'No fields' });
    await r.query(`UPDATE dbo.${info.table} SET ${sets.join(',')} WHERE id=@id`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
