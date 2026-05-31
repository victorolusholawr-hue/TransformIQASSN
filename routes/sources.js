'use strict';
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const { getPool, sql }           = require('../config/database');
const { loginRequired, analystRequired } = require('../middleware/auth');
const { projectAccessRequired }          = require('../middleware/projectAccess');
const { saveUpload }                     = require('../config/storage');
const { parseFile, parseImageWithVision }= require('../services/fileParser');
const {
  extractChunk,
  extractAllChunks,
  logUsage,
  isRateLimited,
  CHUNK_SIZE,
  MAX_CHUNKS,
  MAX_TEXT_CHARS,
  assertAiConfigured,
} = require('../services/ai');
const { buildGraphEdges }                = require('../services/graphBuilder');
const { reconcileProjectSourceStatuses, reconcileSingleSourceStatus } = require('../services/sourceStatus');
const router   = express.Router();

function wantsJson(req) {
  return req.get('X-Requested-With') === 'XMLHttpRequest' ||
    (req.get('Accept') || '').split(',')[0].includes('application/json');
}

async function loadSourceAccess(pool, projectId, userId) {
  const access = await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .input('uid', sql.UniqueIdentifier, userId)
    .query(`
      SELECT p.*, pm.role AS member_role
      FROM dbo.Projects p
      JOIN dbo.ProjectMembers pm ON pm.project_id = p.id
      WHERE p.id=@pid AND pm.user_id=@uid
    `);
  const project = access.recordset[0];
  if (project) {
    try { project.tags = JSON.parse(project.tags || '[]'); } catch (_) { project.tags = []; }
  }
  return project;
}

function safeExtractionError(err) {
  const message = err && err.message ? String(err.message) : 'AI extraction failed. Please try again.';
  return message.slice(0, 500);
}

async function markSourceAiStatus(pool, sourceId, status, errorMessage) {
  const existing = await pool.request()
    .input('id', sql.UniqueIdentifier, sourceId)
    .query('SELECT metadata FROM dbo.Sources WHERE id=@id');
  let metadata = {};
  try { metadata = JSON.parse((existing.recordset[0] && existing.recordset[0].metadata) || '{}'); } catch (_) {}

  if (status === 'failed' && errorMessage) {
    metadata.ai_error = safeExtractionError({ message: errorMessage });
  } else if (status === 'processing' || status === 'done' || status === 'pending') {
    delete metadata.ai_error;
  }

  await pool.request()
    .input('id', sql.UniqueIdentifier, sourceId)
    .input('status', sql.NVarChar, status)
    .input('meta', sql.NVarChar, JSON.stringify(metadata))
    .query('UPDATE dbo.Sources SET ai_status=@status, metadata=@meta WHERE id=@id');
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function parseParticipants(value) {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function inferSourceType(ext, explicit) {
  if (explicit) return explicit;
  const e = String(ext || '').toLowerCase().replace('.', '');
  if (['pptx'].includes(e)) return 'presentation';
  if (['xlsx', 'xls'].includes(e)) return 'spreadsheet';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(e)) return 'image';
  if (e === 'txt') return 'transcript';
  return 'document';
}

function metadataWith(base, updates) {
  return JSON.stringify({ ...(base || {}), ...(updates || {}) });
}

async function clearSourceEntities(pool, sourceId, projectId) {
  for (const t of ['Requirements','Stakeholders','Processes','Decisions','Risks','BusinessRules','Systems','KPIs']) {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, sourceId)
      .query(`DELETE FROM dbo.${t} WHERE source_id=@sid`);
  }
  await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .query('DELETE FROM dbo.GraphEdges WHERE project_id=@pid');
}

async function getReadableSourceText(pool, source) {
  let text = source.extracted_text || '';
  let metadata = parseJson(source.metadata, {});
  const ext = String(source.file_ext || '').toLowerCase().replace('.', '');
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

  if ((!text || metadata.extraction_method === 'ocr-needs-vision') && imageExts.has(ext) && source.file_url) {
    text = await parseImageWithVision(source.file_url);
    metadata = {
      ...metadata,
      extraction_method: 'claude-vision',
      word_count: text ? text.trim().split(/\s+/).filter(Boolean).length : 0,
    };
    await pool.request()
      .input('id',   sql.UniqueIdentifier, source.id)
      .input('text', sql.NVarChar, text || null)
      .input('meta', sql.NVarChar, JSON.stringify(metadata))
      .query("UPDATE dbo.Sources SET extracted_text=@text, extraction_status='done', metadata=@meta WHERE id=@id");
  }

  return { text: text || '', metadata };
}

async function finishExtraction(pool, source, userId) {
  await markSourceAiStatus(pool, source.id, 'done');
  try {
    await buildGraphEdges(source.project_id);
  } catch (err) {
    console.error('[sources/extract] graph rebuild failed after successful extraction:', err);
  }
  try {
    await logUsage(source.project_id, userId, 0, 0, 'extract');
  } catch (err) {
    console.error('[sources/extract] usage logging failed after successful extraction:', err);
  }
}

function duplicateCandidates(existing, name, selfId) {
  const words = normaliseEntityName(name);
  if (!words.length) return [];
  const out = [];
  const self = String(selfId || '').toLowerCase();
  for (const row of existing) {
    const rowId = String(row.id || '').toLowerCase();
    if (self && rowId === self) continue;
    const otherWords = normaliseEntityName(row.name);
    if (!otherWords.length) continue;
    const set = new Set([...words, ...otherWords]);
    const shared = words.filter(w => otherWords.includes(w));
    const similarity = set.size ? shared.length / set.size : 0;
    const subset = shared.length && (words.every(w => otherWords.includes(w)) || otherWords.every(w => words.includes(w)));
    if (similarity > 0.5 || subset) out.push(String(row.id));
  }
  return out;
}

function normaliseEntityName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'sources');
const storage    = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['.pdf','.docx','.xlsx','.xls','.txt','.pptx',
                     '.png','.jpg','.jpeg','.webp','.gif'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// ── List ─────────────────────────────────────────────────────
router.get('/projects/:projectId/sources', loginRequired, projectAccessRequired, async (req, res) => {
  const pool   = await getPool();
  await reconcileProjectSourceStatuses(pool, req.params.projectId);
  const result = await pool.request()
    .input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT * FROM dbo.Sources WHERE project_id=@pid ORDER BY created_at DESC');
  const sources = result.recordset.map(s => ({
    ...s,
    metadata: parseJson(s.metadata, {}),
    participants: parseJson(s.participants, []),
  }));
  res.render('sources/list', {
    title:   'Sources',
    project: req.project,
    member:  req.projectMember,
    sources,
  });
});

// ── Upload ───────────────────────────────────────────────────
router.get('/projects/:projectId/sources/upload', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  let last   = null;
  if (req.query.last) {
    const r = await pool.request()
      .input('id', sql.UniqueIdentifier, req.query.last)
      .input('pid', sql.UniqueIdentifier, req.params.projectId)
      .query('SELECT * FROM dbo.Sources WHERE id=@id AND project_id=@pid');
    last = r.recordset[0] || null;
  }
  res.render('sources/upload', { title: 'Upload Source', project: req.project, last });
});

router.post('/projects/:projectId/sources/upload',
  analystRequired, projectAccessRequired,
  upload.single('file'),
  async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Please select a file to upload.');
      return res.redirect(`/projects/${req.params.projectId}/sources/upload`);
    }
    try {
      const ext      = path.extname(req.file.originalname).toLowerCase();
      const parsed   = await parseFile(req.file.path, ext);
      const fileUrl  = await saveUpload(req.file, 'sources');
      const id       = uuidv4();
      const participants = parseParticipants(req.body.participants);
      const metadata = {
        ...(parsed.metadata || {}),
        participants,
      };
      const extractionStatus = parsed.text
        ? 'done'
        : metadata.extraction_method === 'ocr-needs-vision' ? 'pending' : 'failed';

      const pool = await getPool();
      await pool.request()
        .input('id',      sql.UniqueIdentifier, id)
        .input('pid',     sql.UniqueIdentifier, req.params.projectId)
        .input('name',    sql.NVarChar,         req.file.originalname)
        .input('stype',   sql.NVarChar,         inferSourceType(ext, req.body.source_type))
        .input('furl',    sql.NVarChar,         fileUrl)
        .input('fext',    sql.NVarChar,         ext)
        .input('text',    sql.NVarChar,         parsed.text || null)
        .input('estatus', sql.NVarChar,         extractionStatus)
        .input('uid',     sql.UniqueIdentifier, req.session.userId)
        .input('parts',   sql.NVarChar,         JSON.stringify(participants))
        .input('meta',    sql.NVarChar,         JSON.stringify(metadata))
        .query(`INSERT INTO dbo.Sources
          (id, project_id, name, source_type, file_url, file_ext, extracted_text, extraction_status, uploader_id, participants, metadata)
          VALUES (@id, @pid, @name, @stype, @furl, @fext, @text, @estatus, @uid, @parts, @meta)`);

      res.redirect(`/projects/${req.params.projectId}/sources/upload?last=${id}`);
    } catch (err) {
      console.error('[sources/upload]', err);
      req.flash('error', 'Upload failed. Please try again.');
      res.redirect(`/projects/${req.params.projectId}/sources/upload`);
    }
  }
);

// ── Detail ───────────────────────────────────────────────────
router.get('/sources/:id', loginRequired, async (req, res) => {
  const pool   = await getPool();
  await reconcileSingleSourceStatus(pool, req.params.id);
  const result = await pool.request()
    .input('id', sql.UniqueIdentifier, req.params.id)
    .query('SELECT * FROM dbo.Sources WHERE id=@id');
  const source = result.recordset[0];
  if (!source) return res.status(404).render('error', { title: '404', message: 'Source not found' });

  const project = await loadSourceAccess(pool, source.project_id, req.session.userId);
  if (!project) {
    req.flash('error', 'Access denied.');
    return res.redirect('/dashboard');
  }

  let metadata = {};
  let participants = [];
  try { metadata = JSON.parse(source.metadata || '{}'); } catch (_) {}
  try { participants = JSON.parse(source.participants || '[]'); } catch (_) {}
  source.metadata = metadata;
  source.participants = participants;
  source.text_preview = (source.extracted_text || '').slice(0, 3000);

  res.render('sources/detail', {
    title: source.name,
    source,
    project,
    member: { role: project.member_role },
  });
});

// ── Extract ──────────────────────────────────────────────────
router.post('/sources/:id/extract', analystRequired, async (req, res) => {
  const phase = req.body.phase || 'sync';

  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, req.params.id)
      .query('SELECT * FROM dbo.Sources WHERE id=@id');
    const source = result.recordset[0];
    if (!source) {
      if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'Not found' });
      req.flash('error', 'Source not found.');
      return res.redirect('/dashboard');
    }
    const project = await loadSourceAccess(pool, source.project_id, req.session.userId);
    if (!project) {
      if (wantsJson(req)) return res.status(403).json({ ok: false, error: 'Access denied.' });
      req.flash('error', 'Access denied.');
      return res.redirect('/dashboard');
    }

    if (await isRateLimited(req.session.userId, source.project_id, 'extract')) {
      if (wantsJson(req)) return res.json({ ok: false, error: 'Rate limit reached.' });
      req.flash('error', 'AI rate limit reached. Please try again later.');
      return res.redirect(`/sources/${req.params.id}`);
    }

    assertAiConfigured();

    const readable = await getReadableSourceText(pool, source);
    const text = readable.text;

    if (!text || text.trim().length < 50) {
      if (wantsJson(req)) return res.json({ ok: false, error: 'Not enough text to extract.' });
      req.flash('error', 'Source has insufficient text for extraction.');
      return res.redirect(`/sources/${req.params.id}`);
    }

    // Init phase: return chunk count for chunked UI
    if (phase === 'init') {
      if (text.length > MAX_TEXT_CHARS) {
        const msg = `Source text is too large for AI extraction. Please split it into ${MAX_CHUNKS} or fewer sections.`;
        await markSourceAiStatus(pool, req.params.id, 'failed', msg);
        return res.json({ ok: false, error: msg, redirect_url: `/sources/${req.params.id}` });
      }
      const chunksTotal = Math.ceil(text.length / CHUNK_SIZE);
      await clearSourceEntities(pool, req.params.id, source.project_id);
      const initMetadata = { ...readable.metadata };
      delete initMetadata.ai_error;
      await pool.request()
        .input('id', sql.UniqueIdentifier, req.params.id)
        .input('n',  sql.Int, chunksTotal)
        .input('meta', sql.NVarChar, metadataWith(initMetadata, { ai_started_at: new Date().toISOString() }))
        .query("UPDATE dbo.Sources SET chunks_total=@n, ai_status='pending', metadata=@meta WHERE id=@id");
      return res.json({ ok: true, chunks_total: chunksTotal, redirect_url: `/projects/${source.project_id}` });
    }

    if (phase === 'chunk') {
      const chunkIdx = parseInt(req.body.chunk_idx || '0', 10);
      const retryAttempt = parseInt(req.body.retry_attempt || '0', 10);
      const storedTotal = Number(source.chunks_total || 0);
      const chunksTotal = Math.ceil(text.length / CHUNK_SIZE);
      if (!Number.isInteger(chunkIdx) || chunkIdx < 0 || chunkIdx >= chunksTotal || (storedTotal && chunkIdx >= storedTotal)) {
        const msg = 'Invalid extraction section.';
        await markSourceAiStatus(pool, req.params.id, 'failed', msg);
        return res.json({ ok: false, error: msg });
      }

      if (chunkIdx === 0) {
        await markSourceAiStatus(pool, req.params.id, 'processing');
      } else if (source.ai_status !== 'processing') {
        const msg = 'Extraction was restarted or reset before this section could run. Start again from section 1.';
        await markSourceAiStatus(pool, req.params.id, 'failed', msg);
        return res.json({ ok: false, error: msg });
      }

      const chunkText = text.slice(chunkIdx * CHUNK_SIZE, (chunkIdx + 1) * CHUNK_SIZE);
      let entities;
      try {
        entities = await extractChunk(chunkText);
      } catch (err) {
        const msg = `Processing failed on section ${chunkIdx + 1}: ${safeExtractionError(err)}`;
        if (retryAttempt >= 2) {
          await markSourceAiStatus(pool, req.params.id, 'failed', msg);
        }
        return res.json({ ok: false, error: msg, redirect_url: `/sources/${req.params.id}` });
      }
      const inserted = await _insertEntities(pool, source.project_id, req.params.id, entities);
      const done = chunkIdx >= chunksTotal - 1;
      if (done) {
        await finishExtraction(pool, source, req.session.userId);
      }
      return res.json({
        ok: true,
        done,
        inserted,
        flagged: 0,
        redirect_url: `/projects/${source.project_id}`,
      });
    }

    // Sync / single shot
    if (text.length > MAX_TEXT_CHARS) {
      const msg = `Source text is too large for AI extraction. Please split it into ${MAX_CHUNKS} or fewer sections.`;
      await markSourceAiStatus(pool, req.params.id, 'failed', msg);
      if (wantsJson(req)) return res.json({ ok: false, error: msg });
      req.flash('error', msg);
      return res.redirect(`/sources/${req.params.id}`);
    }
    await markSourceAiStatus(pool, req.params.id, 'processing');
    await clearSourceEntities(pool, req.params.id, source.project_id);

    const { entities } = await extractAllChunks(text);
    await _insertEntities(pool, source.project_id, req.params.id, entities);
    await finishExtraction(pool, source, req.session.userId);

    if (wantsJson(req)) return res.json({ ok: true, done: true, redirect_url: `/projects/${source.project_id}` });
    req.flash('success', 'Entities extracted successfully.');
    res.redirect(`/projects/${source.project_id}`);
  } catch (err) {
    console.error('[sources/extract]', err);
    const errorMessage = safeExtractionError(err);
    try {
      const p2 = await getPool();
      await markSourceAiStatus(p2, req.params.id, 'failed', errorMessage);
    } catch (_) {}
    if (wantsJson(req)) return res.json({ ok: false, error: errorMessage });
    req.flash('error', errorMessage);
    res.redirect(`/sources/${req.params.id}`);
  }
});

router.post('/sources/:id/reset-ai', analystRequired, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, req.params.id)
      .query('SELECT project_id FROM dbo.Sources WHERE id=@id');
    const source = result.recordset[0];
    if (!source) return res.redirect('/dashboard');
    const project = await loadSourceAccess(pool, source.project_id, req.session.userId);
    if (!project) {
      req.flash('error', 'Access denied.');
      return res.redirect('/dashboard');
    }
    await markSourceAiStatus(pool, req.params.id, 'pending');
    req.flash('success', 'AI extraction status reset. You can retry extraction now.');
    res.redirect(`/sources/${req.params.id}`);
  } catch (err) {
    console.error('[sources/reset-ai]', err);
    req.flash('error', 'Could not reset extraction status.');
    res.redirect(`/sources/${req.params.id}`);
  }
});

// ── Delete ───────────────────────────────────────────────────
router.post('/sources/:id/delete', analystRequired, async (req, res) => {
  const pool   = await getPool();
  const result = await pool.request()
    .input('id', sql.UniqueIdentifier, req.params.id)
    .query('SELECT project_id FROM dbo.Sources WHERE id=@id');
  const source = result.recordset[0];
  if (!source) return res.redirect('/dashboard');
  const project = await loadSourceAccess(pool, source.project_id, req.session.userId);
  if (!project) {
    req.flash('error', 'Access denied.');
    return res.redirect('/dashboard');
  }

  for (const t of ['Requirements','Stakeholders','Processes','Decisions','Risks','BusinessRules','Systems','KPIs']) {
    await pool.request().input('sid', sql.UniqueIdentifier, req.params.id)
      .query(`DELETE FROM dbo.${t} WHERE source_id=@sid`);
  }
  await pool.request().input('id', sql.UniqueIdentifier, req.params.id)
    .query('DELETE FROM dbo.Sources WHERE id=@id');
  await buildGraphEdges(source.project_id);

  req.flash('success', 'Source deleted.');
  res.redirect(`/projects/${source.project_id}/sources`);
});

// ── Done IDs (JSON API for progress poll) ────────────────────
router.get('/projects/:projectId/sources/done-ids', loginRequired, projectAccessRequired, async (req, res) => {
  const pool   = await getPool();
  const result = await pool.request()
    .input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query("SELECT id FROM dbo.Sources WHERE project_id=@pid AND ai_status='done'");
  const sourceIds = result.recordset.map(r => r.id);
  res.json({ source_ids: sourceIds, ids: sourceIds });
});

// ── Entity insert helper ─────────────────────────────────────
async function _insertEntities(pool, projectId, sourceId, entities) {
  const { v4: uuid } = require('uuid');
  let inserted = 0;

  if (entities.requirements) {
    for (const e of entities.requirements) {
      await pool.request()
        .input('id',     sql.UniqueIdentifier, uuid())
        .input('pid',    sql.UniqueIdentifier, projectId)
        .input('sid',    sql.UniqueIdentifier, sourceId)
        .input('rtype',  sql.NVarChar, e.req_type || null)
        .input('title',  sql.NVarChar, e.title || '')
        .input('desc',   sql.NVarChar, e.description || null)
        .input('pri',    sql.NVarChar, e.priority || null)
        .input('conf',   sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote',  sql.NVarChar, e.source_quote || null)
        .query('INSERT INTO dbo.Requirements (id,project_id,source_id,req_type,title,description,priority,confidence,source_quote) VALUES (@id,@pid,@sid,@rtype,@title,@desc,@pri,@conf,@quote)');
      inserted++;
    }
  }
  if (entities.stakeholders) {
    const existingStakeholders = await pool.request()
      .input('pid', sql.UniqueIdentifier, projectId)
      .query('SELECT id, name FROM dbo.Stakeholders WHERE project_id=@pid');
    for (const e of entities.stakeholders) {
      const duplicates = duplicateCandidates(existingStakeholders.recordset, e.name || '');
      const newId = uuid();
      await pool.request()
        .input('id',   sql.UniqueIdentifier, newId)
        .input('pid',  sql.UniqueIdentifier, projectId)
        .input('sid',  sql.UniqueIdentifier, sourceId)
        .input('name', sql.NVarChar, e.name || '')
        .input('role', sql.NVarChar, e.role || null)
        .input('org',  sql.NVarChar, e.organization || null)
        .input('inf',  sql.Int, e.influence || null)
        .input('int',  sql.Int, e.interest || null)
        .input('conf', sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote',sql.NVarChar, e.source_quote || null)
        .input('dups', sql.NVarChar, JSON.stringify(duplicates))
        .input('review', sql.Bit, duplicates.length ? 1 : 0)
        .query('INSERT INTO dbo.Stakeholders (id,project_id,source_id,name,role,organization,influence,interest,confidence,source_quote,duplicate_candidates,needs_review) VALUES (@id,@pid,@sid,@name,@role,@org,@inf,@int,@conf,@quote,@dups,@review)');
      inserted++;
      existingStakeholders.recordset.push({ id: newId, name: e.name || '' });
    }
  }
  if (entities.processes) {
    for (const e of entities.processes) {
      await pool.request()
        .input('id',      sql.UniqueIdentifier, uuid())
        .input('pid',     sql.UniqueIdentifier, projectId)
        .input('sid',     sql.UniqueIdentifier, sourceId)
        .input('name',    sql.NVarChar, e.name || '')
        .input('desc',    sql.NVarChar, e.description || null)
        .input('steps',   sql.NVarChar, JSON.stringify(e.steps || []))
        .input('mermaid', sql.NVarChar, e.mermaid_syntax || null)
        .input('conf',    sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote',   sql.NVarChar, e.source_quote || null)
        .query('INSERT INTO dbo.Processes (id,project_id,source_id,name,description,steps,mermaid_syntax,confidence,source_quote) VALUES (@id,@pid,@sid,@name,@desc,@steps,@mermaid,@conf,@quote)');
      inserted++;
    }
  }
  if (entities.decisions) {
    for (const e of entities.decisions) {
      await pool.request()
        .input('id',   sql.UniqueIdentifier, uuid())
        .input('pid',  sql.UniqueIdentifier, projectId)
        .input('sid',  sql.UniqueIdentifier, sourceId)
        .input('title',sql.NVarChar, e.title || '')
        .input('desc', sql.NVarChar, e.description || null)
        .input('rat',  sql.NVarChar, e.rationale || null)
        .input('dm',   sql.NVarChar, e.decision_maker || null)
        .input('stat', sql.NVarChar, e.status || 'proposed')
        .input('conf', sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote',sql.NVarChar, e.source_quote || null)
        .query('INSERT INTO dbo.Decisions (id,project_id,source_id,title,description,rationale,decision_maker,status,confidence,source_quote) VALUES (@id,@pid,@sid,@title,@desc,@rat,@dm,@stat,@conf,@quote)');
      inserted++;
    }
  }
  if (entities.risks) {
    for (const e of entities.risks) {
      await pool.request()
        .input('id',   sql.UniqueIdentifier, uuid())
        .input('pid',  sql.UniqueIdentifier, projectId)
        .input('sid',  sql.UniqueIdentifier, sourceId)
        .input('title',sql.NVarChar, e.title || '')
        .input('desc', sql.NVarChar, e.description || null)
        .input('cat',  sql.NVarChar, e.category || null)
        .input('lik',  sql.Int, e.likelihood || null)
        .input('imp',  sql.Int, e.impact || null)
        .input('mit',  sql.NVarChar, e.mitigation || null)
        .input('own',  sql.NVarChar, e.owner || null)
        .input('conf', sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote',sql.NVarChar, e.source_quote || null)
        .query('INSERT INTO dbo.Risks (id,project_id,source_id,title,description,category,likelihood,impact,mitigation,owner,confidence,source_quote) VALUES (@id,@pid,@sid,@title,@desc,@cat,@lik,@imp,@mit,@own,@conf,@quote)');
      inserted++;
    }
  }
  if (entities.business_rules) {
    for (const e of entities.business_rules) {
      await pool.request()
        .input('id',   sql.UniqueIdentifier, uuid())
        .input('pid',  sql.UniqueIdentifier, projectId)
        .input('sid',  sql.UniqueIdentifier, sourceId)
        .input('title',sql.NVarChar, e.title || '')
        .input('desc', sql.NVarChar, e.description || null)
        .input('cat',  sql.NVarChar, e.category || null)
        .input('conf', sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote',sql.NVarChar, e.source_quote || null)
        .query('INSERT INTO dbo.BusinessRules (id,project_id,source_id,title,description,category,confidence,source_quote) VALUES (@id,@pid,@sid,@title,@desc,@cat,@conf,@quote)');
      inserted++;
    }
  }
  if (entities.systems) {
    for (const e of entities.systems) {
      await pool.request()
        .input('id',    sql.UniqueIdentifier, uuid())
        .input('pid',   sql.UniqueIdentifier, projectId)
        .input('sid',   sql.UniqueIdentifier, sourceId)
        .input('name',  sql.NVarChar, e.name || '')
        .input('stype', sql.NVarChar, e.system_type || null)
        .input('desc',  sql.NVarChar, e.description || null)
        .input('integ', sql.NVarChar, JSON.stringify(e.integrations || []))
        .input('conf',  sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote', sql.NVarChar, e.source_quote || null)
        .query('INSERT INTO dbo.Systems (id,project_id,source_id,name,system_type,description,integrations,confidence,source_quote) VALUES (@id,@pid,@sid,@name,@stype,@desc,@integ,@conf,@quote)');
      inserted++;
    }
  }
  if (entities.kpis) {
    for (const e of entities.kpis) {
      await pool.request()
        .input('id',    sql.UniqueIdentifier, uuid())
        .input('pid',   sql.UniqueIdentifier, projectId)
        .input('sid',   sql.UniqueIdentifier, sourceId)
        .input('name',  sql.NVarChar, e.name || '')
        .input('desc',  sql.NVarChar, e.description || null)
        .input('tval',  sql.NVarChar, e.target_value || null)
        .input('meth',  sql.NVarChar, e.measurement_method || null)
        .input('freq',  sql.NVarChar, e.frequency || null)
        .input('own',   sql.NVarChar, e.owner || null)
        .input('conf',  sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote', sql.NVarChar, e.source_quote || null)
        .query('INSERT INTO dbo.KPIs (id,project_id,source_id,name,description,target_value,measurement_method,frequency,owner,confidence,source_quote) VALUES (@id,@pid,@sid,@name,@desc,@tval,@meth,@freq,@own,@conf,@quote)');
      inserted++;
    }
  }
  return inserted;
}

module.exports = router;
