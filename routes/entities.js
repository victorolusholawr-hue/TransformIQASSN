'use strict';
const express = require('express');
const { getPool, sql }           = require('../config/database');
const { loginRequired, analystRequired } = require('../middleware/auth');
const { projectAccessRequired }          = require('../middleware/projectAccess');
const { buildGraphEdges }                = require('../services/graphBuilder');
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

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function parseEntityJsonFields(type, entity) {
  if (type === 'processes') {
    entity.steps = parseJson(entity.steps, []);
  }
  if (type === 'systems') {
    entity.integrations = parseJson(entity.integrations, []);
  }
  return entity;
}

function normaliseEntityName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stakeholderDuplicateCandidates(rows, stakeholder) {
  const words = normaliseEntityName(stakeholder.name);
  if (!words.length) return [];
  const selfId = String(stakeholder.id || '').toLowerCase();
  const out = [];
  for (const row of rows) {
    const rowId = String(row.id || '').toLowerCase();
    if (!rowId || rowId === selfId) continue;
    const otherWords = normaliseEntityName(row.name);
    if (!otherWords.length) continue;
    const set = new Set([...words, ...otherWords]);
    const shared = words.filter(w => otherWords.includes(w));
    const similarity = set.size ? shared.length / set.size : 0;
    const subset = shared.length && (words.every(w => otherWords.includes(w)) || otherWords.every(w => words.includes(w)));
    if (similarity > 0.5 || subset) out.push(row.id);
  }
  return out;
}

async function backfillStakeholderDuplicateReviews(pool, projectId, stakeholders) {
  let changed = false;
  const validIds = new Set(stakeholders.map(row => String(row.id || '').toLowerCase()).filter(Boolean));
  for (const row of stakeholders) {
    const parsed = Array.isArray(row.duplicate_candidates) ? row.duplicate_candidates : parseJson(row.duplicate_candidates, []);
    const current = parsed.map(String).filter(id => {
      const key = id.toLowerCase();
      return key && key !== String(row.id || '').toLowerCase() && validIds.has(key);
    });
    const candidates = current.length ? current : stakeholderDuplicateCandidates(stakeholders, row).map(String);
    const needsReview = candidates.length ? 1 : 0;
    const oldNeedsReview = Number(row.needs_review || 0);
    row.duplicate_candidates = candidates;
    row.needs_review = needsReview;

    const stored = JSON.stringify(candidates);
    if (stored !== JSON.stringify(current) || oldNeedsReview !== needsReview) {
      changed = true;
      try {
        await pool.request()
          .input('id', sql.UniqueIdentifier, row.id)
          .input('pid', sql.UniqueIdentifier, projectId)
          .input('dups', sql.NVarChar, stored)
          .input('review', sql.Bit, needsReview)
          .query('UPDATE dbo.Stakeholders SET duplicate_candidates=@dups, needs_review=@review WHERE id=@id AND project_id=@pid');
      } catch (err) {
        console.error('[stakeholders] duplicate backfill failed:', err);
      }
    }
  }
  return changed;
}

function enrichStakeholderDuplicateNames(stakeholders) {
  const byId = new Map(stakeholders.map(row => [String(row.id), row]));
  for (const row of stakeholders) {
    const ids = Array.isArray(row.duplicate_candidates) ? row.duplicate_candidates.map(String) : [];
    row.duplicate_candidate_details = ids
      .filter(id => String(id).toLowerCase() !== String(row.id || '').toLowerCase())
      .map(id => byId.get(id))
      .filter(Boolean)
      .map(candidate => ({
        id: candidate.id,
        name: candidate.name || 'Unnamed stakeholder',
        role: candidate.role || '',
        organization: candidate.organization || '',
      }));
    row.duplicate_candidates = row.duplicate_candidate_details.map(candidate => candidate.id);
  }
  return stakeholders.filter(row => Number(row.needs_review || 0) && row.duplicate_candidate_details.length);
}

async function rebuildGraphNonFatal(projectId) {
  try {
    await buildGraphEdges(projectId);
  } catch (err) {
    console.error('[entities] graph rebuild failed:', err);
  }
}

// Compatibility with the original TransformIQ slug.
router.get('/projects/:projectId/business-rules', loginRequired, (req, res) => {
  res.redirect(301, `/projects/${req.params.projectId}/business_rules`);
});

router.get('/projects/:projectId/business-rules/:eid', loginRequired, (req, res) => {
  res.redirect(301, `/projects/${req.params.projectId}/business_rules/${req.params.eid}`);
});

router.post('/projects/:projectId/business-rules/:eid/edit', analystRequired, (req, res) => {
  res.redirect(307, `/projects/${req.params.projectId}/business_rules/${req.params.eid}/edit`);
});

router.post('/projects/:projectId/business-rules/:eid/delete', analystRequired, (req, res) => {
  res.redirect(307, `/projects/${req.params.projectId}/business_rules/${req.params.eid}/delete`);
});

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
      let entities = result.recordset.map(row => parseEntityJsonFields(type, row));
      let duplicateReview = [];
      if (type === 'stakeholders') {
        const allStakeholders = await pool.request()
          .input('pid', sql.UniqueIdentifier, projectId)
          .query('SELECT * FROM dbo.Stakeholders WHERE project_id=@pid ORDER BY created_at DESC');
        const allRows = allStakeholders.recordset.map(row => {
          row.duplicate_candidates = Array.isArray(row.duplicate_candidates)
            ? row.duplicate_candidates
            : parseJson(row.duplicate_candidates, []);
          return row;
        });
        await backfillStakeholderDuplicateReviews(pool, projectId, allRows);
        duplicateReview = enrichStakeholderDuplicateNames(allRows);
        const byId = new Map(allRows.map(row => [String(row.id).toLowerCase(), row]));
        entities = entities.map(row => byId.get(String(row.id).toLowerCase()) || row);
      }
      res.render(`entities/${type}`, {
        title:    type.replace(/_/g, ' '),
        project:  req.project,
        member:   req.projectMember,
        entities,
        duplicateReview,
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

    parseEntityJsonFields(type, entity);

    if (type === 'requirements') {
      let source = null;
      if (entity.source_id) {
        const sourceResult = await pool.request()
          .input('sid', sql.UniqueIdentifier, entity.source_id)
          .input('pid', sql.UniqueIdentifier, projectId)
          .query('SELECT id, name FROM dbo.Sources WHERE id=@sid AND project_id=@pid');
        source = sourceResult.recordset[0] || null;
      }
      return res.render('entities/requirement_detail', {
        title:   entity.title || 'Requirement',
        project: req.project,
        member:  req.projectMember,
        entity,
        source,
        type,
      });
    }

    res.render('entities/detail', {
      title:   entity.title || entity.name,
      project: req.project,
      member:  req.projectMember,
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
          if (f === 'influence' || f === 'interest' || f === 'likelihood' || f === 'impact') {
            const n = parseInt(body[f], 10);
            r.input(f, sql.Int, Number.isFinite(n) ? n : null);
          } else {
            r.input(f, sql.NVarChar, String(body[f]));
          }
        }
      }
      if (type === 'stakeholders') {
        sets.push('needs_review = 0', "duplicate_candidates = '[]'");
      }
      if (!sets.length) { req.flash('error', 'Nothing to update.'); return res.redirect('back'); }

      await r.query(`UPDATE dbo.${table} SET ${sets.join(', ')} WHERE id=@id AND project_id=@pid`);
      await rebuildGraphNonFatal(projectId);
      req.flash('success', 'Updated.');
      const redirectTo = body.redirect_to && String(body.redirect_to).startsWith('/')
        ? String(body.redirect_to)
        : `/projects/${projectId}/${type}`;
      res.redirect(redirectTo);
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
    await rebuildGraphNonFatal(projectId);
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
  const detailPath = `/projects/${req.params.projectId}/requirements/${req.params.eid}`;
  const referer = req.get('referer') || '';
  res.redirect(referer.includes(detailPath) ? detailPath : `/projects/${req.params.projectId}/requirements`);
});

router.post('/projects/:projectId/requirements/:eid/reject', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  await pool.request()
    .input('id', sql.UniqueIdentifier, req.params.eid)
    .query("UPDATE dbo.Requirements SET status='rejected' WHERE id=@id");
  const detailPath = `/projects/${req.params.projectId}/requirements/${req.params.eid}`;
  const referer = req.get('referer') || '';
  res.redirect(referer.includes(detailPath) ? detailPath : `/projects/${req.params.projectId}/requirements`);
});

router.post('/projects/:projectId/requirements/bulk-action', analystRequired, projectAccessRequired, async (req, res) => {
  const { action } = req.body;
  const ids = req.body['entity_ids[]'] || req.body.entity_ids || req.body.ids;
  const idList = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
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
  const keepId = (req.body.keep_id || req.body.target_id || '').trim();
  const discardId = (req.body.discard_id || req.params.eid || '').trim();
  if (!keepId || !discardId || keepId === discardId) {
    req.flash('error', 'Invalid merge request.');
    return res.redirect(`/projects/${req.params.projectId}/stakeholders`);
  }
  const pool = await getPool();
  const rows = await pool.request()
    .input('keep', sql.UniqueIdentifier, keepId)
    .input('discard', sql.UniqueIdentifier, discardId)
    .input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT * FROM dbo.Stakeholders WHERE project_id=@pid AND id IN (@keep, @discard)');
  const kept = rows.recordset.find(r => String(r.id).toLowerCase() === keepId.toLowerCase());
  const discarded = rows.recordset.find(r => String(r.id).toLowerCase() === discardId.toLowerCase());
  if (!kept || !discarded) {
    req.flash('error', 'One or both stakeholders were not found.');
    return res.redirect(`/projects/${req.params.projectId}/stakeholders`);
  }

  const updates = [];
  const r = pool.request()
    .input('keep', sql.UniqueIdentifier, keepId)
    .input('discard', sql.UniqueIdentifier, discardId)
    .input('pid', sql.UniqueIdentifier, req.params.projectId);
  for (const field of ['role', 'organization', 'influence', 'interest']) {
    if ((kept[field] === null || kept[field] === undefined || kept[field] === '') &&
        discarded[field] !== null && discarded[field] !== undefined && discarded[field] !== '') {
      updates.push(`${field}=@${field}`);
      if (field === 'influence' || field === 'interest') r.input(field, sql.Int, discarded[field]);
      else r.input(field, sql.NVarChar, discarded[field]);
    }
  }
  updates.push('needs_review=0', "duplicate_candidates='[]'");
  await r.query(`
    UPDATE dbo.Stakeholders SET ${updates.join(', ')} WHERE id=@keep AND project_id=@pid;
    DELETE FROM dbo.Stakeholders WHERE id=@discard AND project_id=@pid;
  `);
  await rebuildGraphNonFatal(req.params.projectId);
  req.flash('success', 'Stakeholders merged successfully.');
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
