'use strict';
const express = require('express');
const { v4: uuidv4 }  = require('uuid');
const { getPool, sql }  = require('../config/database');
const { loginRequired, analystRequired } = require('../middleware/auth');
const { projectAccessRequired }          = require('../middleware/projectAccess');
const { callClaudeStructured, summariseEntities, logUsage, isRateLimited } = require('../services/ai');
const router = express.Router();

const SYSTEM_PROMPT = 'You are an expert Business Analyst and transformation consultant. Return valid JSON only. No markdown fences.';

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

async function getInsight(pool, projectId, type) {
  const r = await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .input('t',   sql.NVarChar, type)
    .query('SELECT content, generated_at FROM dbo.AIInsights WHERE project_id=@pid AND type=@t');
  return r.recordset[0] ? { content: JSON.parse(r.recordset[0].content), generated_at: r.recordset[0].generated_at } : null;
}

function hasEntities(entities, keys) {
  return keys.some(k => Array.isArray(entities[k]) && entities[k].length);
}

function entityLines(entities, key, labelField = 'title') {
  const items = entities[key] || [];
  return items.slice(0, 50).map(item => {
    const title = item[labelField] || item.title || item.name || 'Untitled';
    const desc = item.description || item.role || item.status || item.priority || '';
    return `- ${title}${desc ? `: ${desc}` : ''}`;
  }).join('\n') || '(none)';
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
    return jsonError(res, 429, 'AI usage limit reached for this period.');
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    if (!hasEntities(entities, ['requirements','processes','systems','stakeholders','risks','decisions'])) {
      return jsonError(res, 400, 'No entities extracted yet. Upload and analyse sources first.');
    }
    const prompt   = `Project: ${req.project.name}
Description: ${req.project.description || 'N/A'}

CURRENT STATE DATA:

Requirements:
${entityLines(entities, 'requirements')}

Processes:
${entityLines(entities, 'processes', 'name')}

Systems:
${entityLines(entities, 'systems', 'name')}

Stakeholders:
${entityLines(entities, 'stakeholders', 'name')}

Risks:
${entityLines(entities, 'risks')}

Decisions:
${entityLines(entities, 'decisions')}

Generate a comprehensive FUTURE STATE analysis describing what the organisation/system should look like after all requirements are implemented.

Return ONLY valid JSON:
{"overview":"2-3 paragraph narrative of the future state vision","process_changes":[{"process_name":"...","current_state":"...","future_state":"...","key_changes":["..."]}],"system_changes":[{"system_name":"...","change_type":"enhance|replace|new|retire","description":"..."}],"key_transformations":[{"title":"...","description":"...","business_value":"..."}],"critical_success_factors":["..."],"recommended_next_steps":["..."],"process_maps":[{"process_name":"...","mermaid":"flowchart LR\\n  A[Step 1] --> B[Step 2]\\n  B --> C[Step 3]"}]}

For process_maps, generate one Mermaid flowchart per process showing its future state flow. Use flowchart LR, simple letter node IDs, no quotes or special chars in node labels, 4-8 steps max per diagram.`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 8000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'future_state', content);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
    res.json({ ok: true });
  } catch (err) {
    console.error('[future-state]', err);
    jsonError(res, 500, err.message || 'Generation failed.');
  }
});

// ── Roadmap ───────────────────────────────────────────────────
router.get('/projects/:projectId/roadmap', loginRequired, projectAccessRequired, async (req, res) => {
  const pool  = await getPool();
  const tasks = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT * FROM dbo.RoadmapTasks WHERE project_id=@pid ORDER BY sort_order, created_at');
  const insight = await getInsight(pool, req.params.projectId, 'roadmap');
  const taskMap = {};
  for (const t of tasks.recordset) taskMap[`${t.phase_name}|||${t.req_title}`] = t;
  const stakeholders = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT name FROM dbo.Stakeholders WHERE project_id=@pid ORDER BY name');
  const shNames = [...new Set(stakeholders.recordset.map(s => (s.name || '').trim()).filter(Boolean))];
  res.render('insights/roadmap', { title: 'Delivery Roadmap', project: req.project, member: req.projectMember, insight, taskMap, shNames });
});

router.post('/projects/:projectId/roadmap', analystRequired, projectAccessRequired, async (req, res) => {
  if (await isRateLimited(req.session.userId, req.params.projectId, 'insight')) {
    return jsonError(res, 429, 'AI usage limit reached for this period.');
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    if (!hasEntities(entities, ['requirements'])) {
      return jsonError(res, 400, 'No requirements extracted yet. Upload and analyse sources first.');
    }
    const prompt   = `Project: ${req.project.name}
Description: ${req.project.description || 'N/A'}

Requirements:
${entityLines(entities, 'requirements')}

Decisions:
${entityLines(entities, 'decisions')}

Group these requirements into 3-4 logical delivery phases based on priority, dependencies, and business value. Earlier phases should deliver the most critical foundations.

Return ONLY valid JSON:
{"phases":[{"name":"Phase 1: Foundation","objective":"...","duration_estimate":"2-3 months","requirements":[{"title":"...","priority":"high|medium|low","rationale":"..."}],"key_deliverables":["..."],"dependencies":["..."]}],"total_estimate":"6-12 months","phasing_rationale":"..."}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'roadmap', content);
    if (content.phases) {
      let order = 0;
      for (const phase of content.phases) {
        for (const task of (phase.requirements || phase.tasks || [])) {
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
    res.json({ ok: true });
  } catch (err) {
    console.error('[roadmap]', err);
    jsonError(res, 500, err.message || 'Generation failed.');
  }
});

router.post('/projects/:projectId/roadmap/update-task', analystRequired, projectAccessRequired, async (req, res) => {
  const { task_id, phase_name, req_title, status, owner, due_date, notes } = req.body;
  const pool = await getPool();
  const dueDate = due_date ? new Date(due_date) : null;
  if (phase_name && req_title) {
    await pool.request()
      .input('id',    sql.UniqueIdentifier, uuidv4())
      .input('pid',   sql.UniqueIdentifier, req.params.projectId)
      .input('phase', sql.NVarChar, phase_name)
      .input('title', sql.NVarChar, req_title)
      .input('st',    sql.NVarChar, status || 'todo')
      .input('own',   sql.NVarChar, owner || null)
      .input('due',   sql.DateTime2, dueDate)
      .input('note',  sql.NVarChar, notes || null)
      .query(`IF EXISTS (SELECT 1 FROM dbo.RoadmapTasks WHERE project_id=@pid AND phase_name=@phase AND req_title=@title)
        UPDATE dbo.RoadmapTasks SET status=@st, owner=@own, due_date=@due, notes=@note WHERE project_id=@pid AND phase_name=@phase AND req_title=@title
      ELSE
        INSERT INTO dbo.RoadmapTasks (id,project_id,phase_name,req_title,status,owner,due_date,notes)
        VALUES (@id,@pid,@phase,@title,@st,@own,@due,@note)`);
  } else if (task_id) {
    await pool.request()
      .input('id',   sql.UniqueIdentifier, task_id)
      .input('st',   sql.NVarChar, status || 'todo')
      .input('own',  sql.NVarChar, owner || null)
      .input('due',  sql.DateTime2, dueDate)
      .input('note', sql.NVarChar, notes || null)
      .query('UPDATE dbo.RoadmapTasks SET status=@st,owner=@own,due_date=@due,notes=@note WHERE id=@id');
  } else {
    return jsonError(res, 400, 'Missing roadmap task identifiers.');
  }
  res.json({ ok: true });
});

router.post('/projects/:projectId/roadmap/delete-task', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  if (req.body.phase_name && req.body.req_title) {
    await pool.request()
      .input('pid', sql.UniqueIdentifier, req.params.projectId)
      .input('phase', sql.NVarChar, req.body.phase_name)
      .input('title', sql.NVarChar, req.body.req_title)
      .query('DELETE FROM dbo.RoadmapTasks WHERE project_id=@pid AND phase_name=@phase AND req_title=@title');
    const insight = await getInsight(pool, req.params.projectId, 'roadmap');
    if (insight && insight.content && Array.isArray(insight.content.phases)) {
      for (const phase of insight.content.phases) {
        if (phase.name === req.body.phase_name) {
          phase.requirements = (phase.requirements || []).filter(r => r.title !== req.body.req_title);
        }
      }
      await saveInsight(pool, req.params.projectId, req.session.userId, 'roadmap', insight.content);
    }
  } else if (req.body.task_id) {
    await pool.request().input('id', sql.UniqueIdentifier, req.body.task_id)
      .query('DELETE FROM dbo.RoadmapTasks WHERE id=@id');
  } else {
    return jsonError(res, 400, 'Missing roadmap task identifiers.');
  }
  res.json({ ok: true });
});

router.post('/projects/:projectId/roadmap/reorder-task', analystRequired, projectAccessRequired, async (req, res) => {
  const { task_id, phase_name, req_title, direction } = req.body;
  if (!['up', 'down'].includes(direction)) return jsonError(res, 400, 'Missing direction.');
  const pool  = await getPool();
  if (phase_name && req_title) {
    const insight = await getInsight(pool, req.params.projectId, 'roadmap');
    if (!insight) return jsonError(res, 404, 'No roadmap.');
    for (const phase of insight.content.phases || []) {
      if (phase.name !== phase_name) continue;
      const reqs = phase.requirements || [];
      const idx = reqs.findIndex(r => r.title === req_title);
      const swap = direction === 'up' ? idx - 1 : idx + 1;
      if (idx >= 0 && swap >= 0 && swap < reqs.length) {
        const tmp = reqs[idx];
        reqs[idx] = reqs[swap];
        reqs[swap] = tmp;
      }
      phase.requirements = reqs;
    }
    await saveInsight(pool, req.params.projectId, req.session.userId, 'roadmap', insight.content);
    return res.json({ ok: true });
  }
  if (!task_id) return jsonError(res, 400, 'Missing roadmap task identifiers.');
  const tRes  = await pool.request().input('id', sql.UniqueIdentifier, task_id)
    .query('SELECT sort_order, phase_name, project_id FROM dbo.RoadmapTasks WHERE id=@id');
  if (!tRes.recordset.length) return res.json({ ok: false });
  const { sort_order, phase_name: storedPhaseName } = tRes.recordset[0];
  const newOrder = direction === 'up' ? sort_order - 1 : sort_order + 1;
  // Swap with neighbour
  const neighbour = await pool.request()
    .input('pid', sql.UniqueIdentifier, req.params.projectId)
    .input('ph',  sql.NVarChar, storedPhaseName)
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
    return jsonError(res, 429, 'AI usage limit reached for this period.');
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    if (!hasEntities(entities, ['requirements'])) {
      return jsonError(res, 400, 'No requirements extracted yet. Upload and analyse sources first.');
    }
    const prompt   = `Project: ${req.project.name}

Requirements:
${entityLines(entities, 'requirements')}

Stakeholders:
${entityLines(entities, 'stakeholders', 'name')}

Convert each requirement into an Agile user story. Map the role to a real stakeholder where possible. Include 2-3 acceptance criteria per story in Given/When/Then format.

Return ONLY a single valid JSON object:
{"stories":[{"requirement_title":"short string","story":"As a [role], I want [feature], so that [benefit].","acceptance_criteria":["Given X When Y Then Z"],"story_points":3,"priority":"high"}]}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'user_stories', content);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
    res.json({ ok: true });
  } catch (err) {
    console.error('[user-stories]', err);
    jsonError(res, 500, err.message || 'Generation failed.');
  }
});

// ── Acceptance Criteria ───────────────────────────────────────
router.get('/projects/:projectId/acceptance-criteria', loginRequired, projectAccessRequired, async (req, res) => {
  const pool    = await getPool();
  const insight = await getInsight(pool, req.params.projectId, 'acceptance_criteria');
  res.render('insights/acceptance_criteria', { title: 'Acceptance Criteria', project: req.project, member: req.projectMember, insight });
});

router.post('/projects/:projectId/acceptance-criteria', analystRequired, projectAccessRequired, async (req, res) => {
  if (await isRateLimited(req.session.userId, req.params.projectId, 'insight')) {
    return jsonError(res, 429, 'AI usage limit reached for this period.');
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    if (!hasEntities(entities, ['requirements'])) {
      return jsonError(res, 400, 'No requirements extracted yet. Upload and analyse sources first.');
    }
    const prompt   = `Project: ${req.project.name}

Requirements:
${entityLines(entities, 'requirements')}

For each requirement generate detailed acceptance criteria in Gherkin format. Include 2-4 scenarios per requirement covering the happy path and key edge cases.

Return ONLY a single valid JSON object:
{"items":[{"requirement_title":"string","req_type":"functional","criteria":[{"given":"string","when":"string","then":"string"}]}]}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'acceptance_criteria', content);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
    res.json({ ok: true });
  } catch (err) {
    console.error('[acceptance-criteria]', err);
    jsonError(res, 500, err.message || 'Generation failed.');
  }
});

// ── Impact Matrix ─────────────────────────────────────────────
router.get('/projects/:projectId/impact-matrix', loginRequired, projectAccessRequired, async (req, res) => {
  const pool    = await getPool();
  const insight = await getInsight(pool, req.params.projectId, 'impact_matrix');
  res.render('insights/impact_matrix', { title: 'Impact Matrix', project: req.project, member: req.projectMember, insight });
});

router.post('/projects/:projectId/impact-matrix', analystRequired, projectAccessRequired, async (req, res) => {
  if (await isRateLimited(req.session.userId, req.params.projectId, 'insight')) {
    return jsonError(res, 429, 'AI usage limit reached for this period.');
  }
  try {
    const entities = await summariseEntities(req.params.projectId);
    if (!hasEntities(entities, ['requirements'])) {
      return jsonError(res, 400, 'No requirements extracted yet. Upload and analyse sources first.');
    }
    const prompt   = `Project: ${req.project.name}

Requirements:
${entityLines(entities, 'requirements')}

Stakeholders:
${entityLines(entities, 'stakeholders', 'name')}

Systems:
${entityLines(entities, 'systems', 'name')}

Processes:
${entityLines(entities, 'processes', 'name')}

For each requirement, identify its change impact: which stakeholders, systems, and processes are affected, the type of change, and the implementation effort.

Return ONLY a single valid JSON object:
{"matrix":[{"requirement_title":"string","change_type":"process","effort_level":"medium","impacted_stakeholders":["name1"],"impacted_systems":["system1"],"impacted_processes":["process1"],"change_description":"string"}]}`;
    const content  = await callClaudeStructured(SYSTEM_PROMPT, prompt, 6000);
    const pool     = await getPool();
    await saveInsight(pool, req.params.projectId, req.session.userId, 'impact_matrix', content);
    await logUsage(req.params.projectId, req.session.userId, 0, 0, 'insight');
    res.json({ ok: true });
  } catch (err) {
    console.error('[impact-matrix]', err);
    jsonError(res, 500, err.message || 'Generation failed.');
  }
});

// ── Voice Capture ─────────────────────────────────────────────
router.get('/projects/:projectId/voice-capture', loginRequired, projectAccessRequired, (req, res) => {
  res.render('insights/voice_capture', { title: 'Voice Capture', project: req.project });
});

router.post('/projects/:projectId/voice-capture/save', analystRequired, projectAccessRequired, async (req, res) => {
  const transcript = (req.body.transcript || '').trim();
  const title = (req.body.title || '').trim() || `Voice Capture ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  if (!transcript) {
    req.flash('error', 'No transcript to save.'); return res.redirect(`/projects/${req.params.projectId}/voice-capture`);
  }
  let participants = [];
  let participantDocs = [];
  let speakerTurns = [];
  try {
    const parsed = req.body.participants ? JSON.parse(req.body.participants) : [];
    if (Array.isArray(parsed)) {
      participantDocs = parsed.slice(0, 50).map(p => ({
        name: String((p && p.name) || '').trim().slice(0, 160),
        role: String((p && p.role) || '').trim().slice(0, 160),
      })).filter(p => p.name);
      participants = participantDocs.map(p => p.role ? `${p.name} - ${p.role}` : p.name);
    }
  } catch (_) {}
  try {
    const parsedTurns = req.body.speaker_turns ? JSON.parse(req.body.speaker_turns) : [];
    if (Array.isArray(parsedTurns)) {
      speakerTurns = parsedTurns.slice(0, 500).map(turn => {
        const speaker = turn && typeof turn.speaker === 'object' ? turn.speaker : {};
        const text = String((turn && turn.text) || '').trim().slice(0, 5000);
        return {
          speaker: {
            name: String(speaker.name || 'Unknown Speaker').trim().slice(0, 160) || 'Unknown Speaker',
            role: String(speaker.role || '').trim().slice(0, 160),
          },
          text,
        };
      }).filter(turn => turn.text);
    }
  } catch (_) {}
  const metadata = {
    word_count: transcript.split(/\s+/).filter(Boolean).length,
    extraction_method: 'voice_transcription',
    participants: participantDocs,
    speaker_turns: speakerTurns,
  };
  const pool = await getPool();
  const id   = uuidv4();
  await pool.request()
    .input('id',   sql.UniqueIdentifier, id)
    .input('pid',  sql.UniqueIdentifier, req.params.projectId)
    .input('name', sql.NVarChar, title)
    .input('text', sql.NVarChar, transcript)
    .input('uid',  sql.UniqueIdentifier, req.session.userId)
    .input('parts', sql.NVarChar, JSON.stringify(participants))
    .input('meta', sql.NVarChar, JSON.stringify(metadata))
    .query(`INSERT INTO dbo.Sources (id, project_id, name, source_type, file_ext, extracted_text, extraction_status, ai_status, participants, uploader_id, metadata)
            VALUES (@id, @pid, @name, 'meeting', 'txt', @text, 'done', 'pending', @parts, @uid, @meta)`);
  req.flash('success', `Transcript "${title}" saved. You can now extract entities from it.`);
  res.redirect(`/projects/${req.params.projectId}/sources`);
});

module.exports = router;
