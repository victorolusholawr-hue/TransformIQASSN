'use strict';
const express = require('express');
const { getPool, sql }    = require('../config/database');
const { loginRequired }   = require('../middleware/auth');
const { projectAccessRequired } = require('../middleware/projectAccess');
const { callClaudeStructured, summariseEntities, logUsage } = require('../services/ai');
const router = express.Router();

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

// ── Process Map ──────────────────────────────────────────────
router.get('/projects/:projectId/visualize/process-map', loginRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const pid  = req.params.projectId;
  const processes = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query('SELECT * FROM dbo.Processes WHERE project_id=@pid ORDER BY name');
  const rows = processes.recordset.map(p => ({
    ...p,
    steps: parseJson(p.steps, []),
  }));
  let selected = null;
  if (req.query.process_id) {
    selected = rows.find(p => p.id === req.query.process_id) || null;
  }
  res.render('visualize/process_map', {
    title:     'Process Map',
    project:   req.project,
    processes: rows,
    selected,
  });
});

// ── RACI Matrix ──────────────────────────────────────────────
router.get('/projects/:projectId/visualize/raci', loginRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const pid  = req.params.projectId;
  const procs  = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query('SELECT id, name FROM dbo.Processes WHERE project_id=@pid ORDER BY name');
  const stakes = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query('SELECT id, name, role FROM dbo.Stakeholders WHERE project_id=@pid ORDER BY name');
  // RACI stored as JSON in AIInsights with type='raci'
  const raciRow = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query("SELECT content FROM dbo.AIInsights WHERE project_id=@pid AND type='raci'");
  const raci = raciRow.recordset[0] ? JSON.parse(raciRow.recordset[0].content) : {};

  res.render('visualize/raci', {
    title:        'RACI Matrix',
    project:      req.project,
    member:       req.projectMember,
    processes:    procs.recordset,
    stakeholders: stakes.recordset,
    raci,
  });
});

router.post('/projects/:projectId/visualize/raci/update-cell', loginRequired, projectAccessRequired, async (req, res) => {
  if (req.projectMember.role === 'viewer') return res.status(403).json({ ok: false, error: 'Viewers cannot update RACI assignments.' });
  const { process_id, stakeholder_id } = req.body;
  const value = req.body.assignment !== undefined ? req.body.assignment : req.body.value;
  const pool = await getPool();
  const pid  = req.params.projectId;
  const existing = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query("SELECT content FROM dbo.AIInsights WHERE project_id=@pid AND type='raci'");
  const raci = existing.recordset[0] ? JSON.parse(existing.recordset[0].content) : {};
  if (!raci[process_id]) raci[process_id] = {};
  if (value) raci[process_id][stakeholder_id] = value;
  else delete raci[process_id][stakeholder_id];
  const jsonVal = JSON.stringify(raci);
  await pool.request()
    .input('pid',  sql.UniqueIdentifier, pid)
    .input('uid',  sql.UniqueIdentifier, req.session.userId)
    .input('val',  sql.NVarChar,         jsonVal)
    .query(`
      IF EXISTS (SELECT 1 FROM dbo.AIInsights WHERE project_id=@pid AND type='raci')
        UPDATE dbo.AIInsights SET content=@val WHERE project_id=@pid AND type='raci'
      ELSE
        INSERT INTO dbo.AIInsights (project_id, type, content, generated_by) VALUES (@pid, 'raci', @val, @uid)
    `);
  res.json({ ok: true });
});

// ── Stakeholder Map ──────────────────────────────────────────
router.get('/projects/:projectId/visualize/stakeholder-map', loginRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const stakes = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT id, name, role, influence, interest FROM dbo.Stakeholders WHERE project_id=@pid ORDER BY name');
  const scatterData = stakes.recordset.map(s => ({
    x: s.interest || 0,
    y: s.influence || 0,
    label: s.name,
    role: s.role || '',
  }));
  res.render('visualize/stakeholder_map', {
    title:        'Stakeholder Map',
    project:      req.project,
    stakeholders: stakes.recordset,
    scatterData,
  });
});

// ── Gap Analysis ─────────────────────────────────────────────
router.get('/projects/:projectId/visualize/gap-analysis', loginRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const existing = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query("SELECT content, generated_at FROM dbo.AIInsights WHERE project_id=@pid AND type='gap_analysis'");
  const insight = existing.recordset[0] ? JSON.parse(existing.recordset[0].content) : null;
  const stats = {};
  for (const [key, table] of [
    ['requirements', 'Requirements'],
    ['stakeholders', 'Stakeholders'],
    ['processes', 'Processes'],
    ['risks', 'Risks'],
    ['systems', 'Systems'],
  ]) {
    const count = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
      .query(`SELECT COUNT(*) AS cnt FROM dbo.${table} WHERE project_id=@pid`);
    stats[key] = count.recordset[0].cnt;
  }
  res.render('visualize/gap_analysis', {
    title:        'Gap Analysis',
    project:      req.project,
    member:       req.projectMember,
    insight,
    stats,
    generated_at: existing.recordset[0] ? existing.recordset[0].generated_at : null,
  });
});

router.post('/projects/:projectId/visualize/gap-analysis', loginRequired, projectAccessRequired, async (req, res) => {
  if (req.projectMember.role === 'viewer') {
    req.flash('error', 'Viewers cannot generate analysis.');
    return res.redirect(`/projects/${req.params.projectId}/visualize/gap-analysis`);
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    const sysPrompt = `You are an expert Business Analyst. Return valid JSON only.`;
    const userPrompt = `Based on these entities from a transformation project, generate a structured gap analysis.
Return: { "current_state": str, "future_state": str, "gaps": [{"area":str,"current":str,"desired":str,"gap":str,"priority":"high"|"medium"|"low"}], "recommendations": [str] }

Entities: ${JSON.stringify(entities, null, 2).slice(0, 8000)}`;

    const insight = await callClaudeStructured(sysPrompt, userPrompt, 4096);
    const pool    = await getPool();
    await pool.request()
      .input('pid', sql.UniqueIdentifier, req.params.projectId)
      .input('uid', sql.UniqueIdentifier, req.session.userId)
      .input('val', sql.NVarChar, JSON.stringify(insight))
      .query(`
        IF EXISTS (SELECT 1 FROM dbo.AIInsights WHERE project_id=@pid AND type='gap_analysis')
          UPDATE dbo.AIInsights SET content=@val, generated_by=@uid, generated_at=GETUTCDATE() WHERE project_id=@pid AND type='gap_analysis'
        ELSE
          INSERT INTO dbo.AIInsights (project_id, type, content, generated_by) VALUES (@pid, 'gap_analysis', @val, @uid)
      `);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
  } catch (err) {
    console.error('[gap-analysis]', err);
    req.flash('error', 'AI generation failed.');
  }
  res.redirect(`/projects/${req.params.projectId}/visualize/gap-analysis`);
});

// ── Risk Heatmap ─────────────────────────────────────────────
router.get('/projects/:projectId/visualize/risk-heatmap', loginRequired, projectAccessRequired, async (req, res) => {
  const pool  = await getPool();
  const risks = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT id, title, category, likelihood, impact FROM dbo.Risks WHERE project_id=@pid ORDER BY created_at DESC');
  const matrix = {};
  for (let l = 1; l <= 5; l++) {
    for (let i = 1; i <= 5; i++) matrix[`${l},${i}`] = [];
  }
  for (const risk of risks.recordset) {
    const l = Number(risk.likelihood || 0);
    const i = Number(risk.impact || 0);
    if (l >= 1 && l <= 5 && i >= 1 && i <= 5) matrix[`${l},${i}`].push(risk);
  }
  res.render('visualize/risk_heatmap', {
    title:   'Risk Heatmap',
    project: req.project,
    risks:   risks.recordset,
    matrix,
    matrixJson: JSON.stringify(matrix),
  });
});

module.exports = router;
