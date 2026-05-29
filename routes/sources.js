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
const { extractAllChunks, logUsage, isRateLimited } = require('../services/ai');
const { buildGraphEdges }                = require('../services/graphBuilder');
const router   = express.Router();

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
  const result = await pool.request()
    .input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT * FROM dbo.Sources WHERE project_id=@pid ORDER BY created_at DESC');
  res.render('sources/list', {
    title:   'Sources',
    project: req.project,
    sources: result.recordset,
  });
});

// ── Upload ───────────────────────────────────────────────────
router.get('/projects/:projectId/sources/upload', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  let last   = null;
  if (req.query.last) {
    const r = await pool.request()
      .input('id', sql.UniqueIdentifier, req.query.last)
      .query('SELECT * FROM dbo.Sources WHERE id=@id');
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

      const pool = await getPool();
      await pool.request()
        .input('id',      sql.UniqueIdentifier, id)
        .input('pid',     sql.UniqueIdentifier, req.params.projectId)
        .input('name',    sql.NVarChar,         req.file.originalname)
        .input('stype',   sql.NVarChar,         req.body.source_type || null)
        .input('furl',    sql.NVarChar,         fileUrl)
        .input('fext',    sql.NVarChar,         ext)
        .input('text',    sql.NVarChar,         parsed.text || null)
        .input('estatus', sql.NVarChar,         parsed.text ? 'done' : 'pending')
        .input('uid',     sql.UniqueIdentifier, req.session.userId)
        .input('meta',    sql.NVarChar,         JSON.stringify(parsed.metadata || {}))
        .query(`INSERT INTO dbo.Sources
          (id, project_id, name, source_type, file_url, file_ext, extracted_text, extraction_status, uploader_id, metadata)
          VALUES (@id, @pid, @name, @stype, @furl, @fext, @text, @estatus, @uid, @meta)`);

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
  const result = await pool.request()
    .input('id', sql.UniqueIdentifier, req.params.id)
    .query('SELECT * FROM dbo.Sources WHERE id=@id');
  const source = result.recordset[0];
  if (!source) return res.status(404).render('error', { title: '404', message: 'Source not found' });
  res.render('sources/detail', { title: source.name, source });
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
    if (!source) return res.status(404).json({ ok: false, error: 'Not found' });

    if (await isRateLimited(req.session.userId, source.project_id, 'extract')) {
      if (req.accepts('json')) return res.json({ ok: false, error: 'Rate limit reached.' });
      req.flash('error', 'AI rate limit reached. Please try again later.');
      return res.redirect(`/sources/${req.params.id}`);
    }

    // Vision fallback for images with < 20 words
    let text = source.extracted_text || '';
    const meta = JSON.parse(source.metadata || '{}');
    if (meta.extraction_method === 'ocr-needs-vision' && source.file_url) {
      text = await parseImageWithVision(source.file_url);
      await pool.request()
        .input('id',   sql.UniqueIdentifier, req.params.id)
        .input('text', sql.NVarChar, text)
        .query("UPDATE dbo.Sources SET extracted_text=@text, extraction_status='done' WHERE id=@id");
    }

    if (!text || text.trim().length < 50) {
      if (req.accepts('json')) return res.json({ ok: false, error: 'Not enough text to extract.' });
      req.flash('error', 'Source has insufficient text for extraction.');
      return res.redirect(`/sources/${req.params.id}`);
    }

    // Init phase: return chunk count for chunked UI
    if (phase === 'init') {
      const chunkSize   = 6000;
      const chunksTotal = Math.ceil(text.length / chunkSize);
      await pool.request()
        .input('id', sql.UniqueIdentifier, req.params.id)
        .input('n',  sql.Int, chunksTotal)
        .query("UPDATE dbo.Sources SET ai_status='processing', chunks_total=@n WHERE id=@id");
      return res.json({ ok: true, chunks_total: chunksTotal });
    }

    // Sync / single shot
    await pool.request().input('id', sql.UniqueIdentifier, req.params.id)
      .query("UPDATE dbo.Sources SET ai_status='processing' WHERE id=@id");

    // Delete stale entities for this source
    for (const t of ['Requirements','Stakeholders','Processes','Decisions','Risks','BusinessRules','Systems','KPIs']) {
      await pool.request()
        .input('sid', sql.UniqueIdentifier, req.params.id)
        .query(`DELETE FROM dbo.${t} WHERE source_id=@sid`);
    }

    const { entities } = await extractAllChunks(text);
    await _insertEntities(pool, source.project_id, req.params.id, entities);
    await buildGraphEdges(source.project_id);
    await logUsage(source.project_id, req.session.userId, 0, 0, 'extract');

    await pool.request().input('id', sql.UniqueIdentifier, req.params.id)
      .query("UPDATE dbo.Sources SET ai_status='done' WHERE id=@id");

    if (req.accepts('json')) return res.json({ ok: true, done: true });
    req.flash('success', 'Entities extracted successfully.');
    res.redirect(`/projects/${source.project_id}`);
  } catch (err) {
    console.error('[sources/extract]', err);
    if (req.accepts('json')) return res.json({ ok: false, error: err.message });
    req.flash('error', 'Extraction failed.');
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

  for (const t of ['Requirements','Stakeholders','Processes','Decisions','Risks','BusinessRules','Systems','KPIs']) {
    await pool.request().input('sid', sql.UniqueIdentifier, req.params.id)
      .query(`DELETE FROM dbo.${t} WHERE source_id=@sid`);
  }
  await pool.request().input('id', sql.UniqueIdentifier, req.params.id)
    .query('DELETE FROM dbo.Sources WHERE id=@id');

  req.flash('success', 'Source deleted.');
  res.redirect(`/projects/${source.project_id}/sources`);
});

// ── Done IDs (JSON API for progress poll) ────────────────────
router.get('/projects/:projectId/sources/done-ids', loginRequired, projectAccessRequired, async (req, res) => {
  const pool   = await getPool();
  const result = await pool.request()
    .input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query("SELECT id FROM dbo.Sources WHERE project_id=@pid AND ai_status='done'");
  res.json({ ids: result.recordset.map(r => r.id) });
});

// ── Entity insert helper ─────────────────────────────────────
async function _insertEntities(pool, projectId, sourceId, entities) {
  const { v4: uuid } = require('uuid');

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
    }
  }
  if (entities.stakeholders) {
    for (const e of entities.stakeholders) {
      await pool.request()
        .input('id',   sql.UniqueIdentifier, uuid())
        .input('pid',  sql.UniqueIdentifier, projectId)
        .input('sid',  sql.UniqueIdentifier, sourceId)
        .input('name', sql.NVarChar, e.name || '')
        .input('role', sql.NVarChar, e.role || null)
        .input('org',  sql.NVarChar, e.organization || null)
        .input('inf',  sql.Int, e.influence || null)
        .input('int',  sql.Int, e.interest || null)
        .input('conf', sql.Decimal(3,2), e.confidence || 0.5)
        .input('quote',sql.NVarChar, e.source_quote || null)
        .query('INSERT INTO dbo.Stakeholders (id,project_id,source_id,name,role,organization,influence,interest,confidence,source_quote) VALUES (@id,@pid,@sid,@name,@role,@org,@inf,@int,@conf,@quote)');
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
    }
  }
}

module.exports = router;
