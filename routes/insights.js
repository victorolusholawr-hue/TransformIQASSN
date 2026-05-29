'use strict';
const express = require('express');
const { v4: uuidv4 }  = require('uuid');
const { getPool, sql }  = require('../config/database');
const { loginRequired, analystRequired } = require('../middleware/auth');
const { projectAccessRequired }          = require('../middleware/projectAccess');
const { callClaudeStructured, summariseEntities, logUsage, isRateLimited } = require('../services/ai');
const router = express.Router();

const SYSTEM_PROMPT = 'You are an expert Business Analyst and transformation consultant. Return valid JSON only. No markdown fences.';

async function getInsight(pool, projectId, type) {
  const r = await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .input('t',   sql.NVarChar, type)
    .query('SELECT content, generated_at FROM dbo.AIInsights WHERE project_id=@pid AND type=@t');
  return r.recordset[0] ? { content: JSON.parse(r.recordset[0].content), generated_at: r.recordset[0].generated_at } : null;
}

async function saveInsight(pool, projectId, userId, type, content) {
  const json = JSON.stringify(content);
  await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .input('uid', sql.UniqueIdentifier, userId)
    .input('t',   sql.NVarChar, type)
    .input('val', sql.NVarChar, json)
    .query(`
      IF EXISTS (SELECT 1 FROM dbo.AIInsights WHERE project_id=@pid AND type=@t)
        UPDATE dbo.AIInsights SET content=@val, generated_by=@uid, generated_at=GETUTCDATE() WHERE project_id=@pid AND type=@t
      ELSE
        INSERT INTO dbo.AIInsights (project_id, type, content, generated_by) VALUES (@pid, @t, @val, @uid)
    `);
}

// ── Future State ─────────────────────────────────────────────
router.get('/projects/:projectId/future-state', loginRequired, projectAccessRequired, async (req, res) => {
  const pool    = await getPool();
  const insight = await getInsight(pool, req.params.projectId, 'future_state');
  res.render('insights/future_state', { title: 'Future State', project: req.project, member: req.projectMember, insight });
});

router.post('/projects/:projectId/future-state', analystRequired, projectAccessRequired, async (req, res) => {
  if (await isRateLimited(req.session.userId, req.params.projectId, 'insight')) {
    req.flash('error', 'Rate limit reached.'); return res.redirect(`/projects/${req.params.projectId}/future-state`);
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    const prompt   = `Generate a future state analysis for this transformation project.
Return: { "narrative": str, "scenarios": [{"title":str,"description":str,"mermaid_syntax":str}], "key_changes": [str], "success_factors": [str] }
Entities: ${JSON.stringify(entities).slice(0, 8000)}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'future_state', content);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
  } catch (err) { console.error('[future-state]', err); req.flash('error', 'Generation failed.'); }
  res.redirect(`/projects/${req.params.projectId}/future-state`);
});

// ── Roadmap ───────────────────────────────────────────────────
router.get('/projects/:projectId/roadmap', loginRequired, projectAccessRequired, async (req, res) => {
  const pool  = await getPool();
  const tasks = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT * FROM dbo.RoadmapTasks WHERE project_id=@pid ORDER BY sort_order, created_at');
  const insight = await getInsight(pool, req.params.projectId, 'roadmap');
  const phases  = {};
  for (const t of tasks.recordset) {
    if (!phases[t.phase_name]) phases[t.phase_name] = [];
    phases[t.phase_name].push(t);
  }
  res.render('insights/roadmap', { title: 'Delivery Roadmap', project: req.project, member: req.projectMember, phases, insight });
});

router.post('/projects/:projectId/roadmap', analystRequired, projectAccessRequired, async (req, res) => {
  if (await isRateLimited(req.session.userId, req.params.projectId, 'insight')) {
    req.flash('error', 'Rate limit reached.'); return res.redirect(`/projects/${req.params.projectId}/roadmap`);
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    const prompt   = `Generate a phased delivery roadmap.
Return: { "phases": [{"name":str,"duration":str,"objectives":[str],"tasks":[{"title":str,"description":str,"priority":"high"|"medium"|"low"}]}], "total_duration":str, "critical_path":[str] }
Entities: ${JSON.stringify(entities).slice(0, 8000)}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'roadmap', content);
    // Seed roadmap tasks from AI output
    if (content.phases) {
      let order = 0;
      for (const phase of content.phases) {
        for (const task of (phase.tasks || [])) {
          try {
            await pool.request()
              .input('id',    sql.UniqueIdentifier, uuidv4())
              .input('pid',   sql.UniqueIdentifier, req.params.projectId)
              .input('phase', sql.NVarChar, phase.name)
              .input('title', sql.NVarChar, task.title || 'Task')
              .input('ord',   sql.Int, order++)
              .query(`IF NOT EXISTS (SELECT 1 FROM dbo.RoadmapTasks WHERE project_id=@pid AND phase_name=@phase AND req_title=@title)
                INSERT INTO dbo.RoadmapTasks (id,project_id,phase_name,req_title,sort_order) VALUES (@id,@pid,@phase,@title,@ord)`);
          } catch(_) {}
        }
      }
    }
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
  } catch (err) { console.error('[roadmap]', err); req.flash('error', 'Generation failed.'); }
  res.redirect(`/projects/${req.params.projectId}/roadmap`);
});

router.post('/projects/:projectId/roadmap/update-task', analystRequired, projectAccessRequired, async (req, res) => {
  const { task_id, status, owner, due_date, notes } = req.body;
  const pool = await getPool();
  await pool.request()
    .input('id',   sql.UniqueIdentifier, task_id)
    .input('st',   sql.NVarChar, status || 'todo')
    .input('own',  sql.NVarChar, owner  || null)
    .input('due',  sql.NVarChar, due_date || null)
    .input('note', sql.NVarChar, notes  || null)
    .query('UPDATE dbo.RoadmapTasks SET status=@st,owner=@own,notes=@note WHERE id=@id');
  res.json({ ok: true });
});

router.post('/projects/:projectId/roadmap/delete-task', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  await pool.request().input('id', sql.UniqueIdentifier, req.body.task_id)
    .query('DELETE FROM dbo.RoadmapTasks WHERE id=@id');
  res.json({ ok: true });
});

router.post('/projects/:projectId/roadmap/reorder-task', analystRequired, projectAccessRequired, async (req, res) => {
  const { task_id, direction } = req.body;
  const pool  = await getPool();
  const tRes  = await pool.request().input('id', sql.UniqueIdentifier, task_id)
    .query('SELECT sort_order, phase_name, project_id FROM dbo.RoadmapTasks WHERE id=@id');
  if (!tRes.recordset.length) return res.json({ ok: false });
  const { sort_order, phase_name } = tRes.recordset[0];
  const newOrder = direction === 'up' ? sort_order - 1 : sort_order + 1;
  // Swap with neighbour
  const neighbour = await pool.request()
    .input('pid', sql.UniqueIdentifier, req.params.projectId)
    .input('ph',  sql.NVarChar, phase_name)
    .input('ord', sql.Int, newOrder)
    .query('SELECT id FROM dbo.RoadmapTasks WHERE project_id=@pid AND phase_name=@ph AND sort_order=@ord');
  if (neighbour.recordset.length) {
    await pool.request()
      .input('nid', sql.UniqueIdentifier, neighbour.recordset[0].id)
      .input('oid', sql.Int, sort_order)
      .query('UPDATE dbo.RoadmapTasks SET sort_order=@oid WHERE id=@nid');
  }
  await pool.request()
    .input('id',  sql.UniqueIdentifier, task_id)
    .input('ord', sql.Int, newOrder)
    .query('UPDATE dbo.RoadmapTasks SET sort_order=@ord WHERE id=@id');
  res.json({ ok: true });
});

// ── User Stories ─────────────────────────────────────────────
router.get('/projects/:projectId/user-stories', loginRequired, projectAccessRequired, async (req, res) => {
  const pool    = await getPool();
  const insight = await getInsight(pool, req.params.projectId, 'user_stories');
  res.render('insights/user_stories', { title: 'User Stories', project: req.project, member: req.projectMember, insight });
});

router.post('/projects/:projectId/user-stories', analystRequired, projectAccessRequired, async (req, res) => {
  if (await isRateLimited(req.session.userId, req.params.projectId, 'insight')) {
    req.flash('error', 'Rate limit reached.'); return res.redirect(`/projects/${req.params.projectId}/user-stories`);
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    const prompt   = `Generate user stories for each stakeholder persona.
Return: { "personas": [{"name":str,"role":str,"stories":[{"as_a":str,"i_want":str,"so_that":str,"acceptance_criteria":[str],"priority":"high"|"medium"|"low"}]}] }
Entities: ${JSON.stringify(entities).slice(0, 8000)}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'user_stories', content);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
  } catch (err) { console.error('[user-stories]', err); req.flash('error', 'Generation failed.'); }
  res.redirect(`/projects/${req.params.projectId}/user-stories`);
});

// ── Acceptance Criteria ───────────────────────────────────────
router.get('/projects/:projectId/acceptance-criteria', loginRequired, projectAccessRequired, async (req, res) => {
  const pool    = await getPool();
  const insight = await getInsight(pool, req.params.projectId, 'acceptance_criteria');
  res.render('insights/acceptance_criteria', { title: 'Acceptance Criteria', project: req.project, member: req.projectMember, insight });
});

router.post('/projects/:projectId/acceptance-criteria', analystRequired, projectAccessRequired, async (req, res) => {
  if (await isRateLimited(req.session.userId, req.params.projectId, 'insight')) {
    req.flash('error', 'Rate limit reached.'); return res.redirect(`/projects/${req.params.projectId}/acceptance-criteria`);
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    const prompt   = `Generate Gherkin-style acceptance criteria for the confirmed requirements.
Return: { "criteria": [{"requirement_title":str,"given":[str],"when":[str],"then":[str],"notes":str}] }
Entities: ${JSON.stringify(entities).slice(0, 8000)}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'acceptance_criteria', content);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
  } catch (err) { console.error('[acceptance-criteria]', err); req.flash('error', 'Generation failed.'); }
  res.redirect(`/projects/${req.params.projectId}/acceptance-criteria`);
});

// ── Impact Matrix ─────────────────────────────────────────────
router.get('/projects/:projectId/impact-matrix', loginRequired, projectAccessRequired, async (req, res) => {
  const pool    = await getPool();
  const insight = await getInsight(pool, req.params.projectId, 'impact_matrix');
  res.render('insights/impact_matrix', { title: 'Impact Matrix', project: req.project, member: req.projectMember, insight });
});

router.post('/projects/:projectId/impact-matrix', analystRequired, projectAccessRequired, async (req, res) => {
  if (await isRateLimited(req.session.userId, req.params.projectId, 'insight')) {
    req.flash('error', 'Rate limit reached.'); return res.redirect(`/projects/${req.params.projectId}/impact-matrix`);
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    const prompt   = `Generate a change impact matrix by department and system.
Return: { "departments": [str], "systems": [str], "impacts": [{"change":str,"affected_departments":[str],"affected_systems":[str],"impact_level":"high"|"medium"|"low","description":str}] }
Entities: ${JSON.stringify(entities).slice(0, 8000)}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'impact_matrix', content);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
  } catch (err) { console.error('[impact-matrix]', err); req.flash('error', 'Generation failed.'); }
  res.redirect(`/projects/${req.params.projectId}/impact-matrix`);
});

// ── Voice Capture ─────────────────────────────────────────────
router.get('/projects/:projectId/voice-capture', loginRequired, projectAccessRequired, (req, res) => {
  res.render('insights/voice_capture', { title: 'Voice Capture', project: req.project });
});

router.post('/projects/:projectId/voice-capture/save', analystRequired, projectAccessRequired, async (req, res) => {
  const { transcript } = req.body;
  if (!transcript || transcript.trim().length < 10) {
    req.flash('error', 'Transcript is too short.'); return res.redirect(`/projects/${req.params.projectId}/voice-capture`);
  }
  const pool = await getPool();
  const id   = uuidv4();
  await pool.request()
    .input('id',   sql.UniqueIdentifier, id)
    .input('pid',  sql.UniqueIdentifier, req.params.projectId)
    .input('name', sql.NVarChar, `Voice Capture — ${new Date().toLocaleString()}`)
    .input('text', sql.NVarChar, transcript)
    .input('uid',  sql.UniqueIdentifier, req.session.userId)
    .query(`INSERT INTO dbo.Sources (id, project_id, name, source_type, extracted_text, extraction_status, ai_status, uploader_id)
            VALUES (@id, @pid, @name, 'voice', @text, 'done', 'pending', @uid)`);
  req.flash('success', 'Transcript saved as a source. You can now extract entities from it.');
  res.redirect(`/projects/${req.params.projectId}/sources`);
});

module.exports = router;
