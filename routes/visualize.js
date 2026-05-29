'use strict';
const express = require('express');
const { getPool, sql }    = require('../config/database');
const { loginRequired }   = require('../middleware/auth');
const { projectAccessRequired } = require('../middleware/projectAccess');
const { callClaudeStructured, summariseEntities, logUsage } = require('../services/ai');
const router = express.Router();

// ── Process Map ──────────────────────────────────────────────
router.get('/projects/:projectId/visualize/process-map', loginRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const pid  = req.params.projectId;
  const processes = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query('SELECT * FROM dbo.Processes WHERE project_id=@pid ORDER BY name');
  let selected = null;
  if (req.query.process_id) {
    selected = processes.recordset.find(p => p.id === req.query.process_id) || null;
  }
  res.render('visualize/process_map', {
    title:     'Process Map',
    project:   req.project,
    processes: processes.recordset,
    selected,
  });
});

// ── RACI Matrix ──────────────────────────────────────────────
router.get('/projects/:projectId/visualize/raci', loginRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const pid  = req.params.projectId;
  const procs  = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query('SELECT id, name FROM dbo.Processes WHERE project_id=@pid');
  const stakes = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query('SELECT id, name FROM dbo.Stakeholders WHERE project_id=@pid');
  // RACI stored as JSON in AIInsights with type='raci'
  const raciRow = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query("SELECT content FROM dbo.AIInsights WHERE project_id=@pid AND type='raci'");
  const raci = raciRow.recordset[0] ? JSON.parse(raciRow.recordset[0].content) : {};

  res.render('visualize/raci', {
    title:        'RACI Matrix',
    project:      req.project,
    processes:    procs.recordset,
    stakeholders: stakes.recordset,
    raci,
  });
});

router.post('/projects/:projectId/visualize/raci/update-cell', loginRequired, projectAccessRequired, async (req, res) => {
  const { process_id, stakeholder_id, value } = req.body;
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
    .query('SELECT id, name, role, influence, interest FROM dbo.Stakeholders WHERE project_id=@pid');
  res.render('visualize/stakeholder_map', {
    title:        'Stakeholder Map',
    project:      req.project,
    stakeholders: stakes.recordset,
  });
});

// ── Gap Analysis ─────────────────────────────────────────────
router.get('/projects/:projectId/visualize/gap-analysis', loginRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const existing = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query("SELECT content, generated_at FROM dbo.AIInsights WHERE project_id=@pid AND type='gap_analysis'");
  const insight = existing.recordset[0] ? JSON.parse(existing.recordset[0].content) : null;
  res.render('visualize/gap_analysis', {
    title:        'Gap Analysis',
    project:      req.project,
    member:       req.projectMember,
    insight,
    generated_at: existing.recordset[0] ? existing.recordset[0].generated_at : null,
  });
});

router.post('/projects/:projectId/visualize/gap-analysis', loginRequired, projectAccessRequired, async (req, res) => {
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
    .query('SELECT id, title, likelihood, impact FROM dbo.Risks WHERE project_id=@pid');
  res.render('visualize/risk_heatmap', {
    title:   'Risk Heatmap',
    project: req.project,
    risks:   risks.recordset,
  });
});

module.exports = router;
