'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getPool, sql }    = require('../config/database');
const { analystRequired } = require('../middleware/auth');
const { projectAccessRequired } = require('../middleware/projectAccess');
const { saveBuffer }       = require('../config/storage');
const { buildBrd, buildFrd, buildRiskRegister, buildExecutiveSummary, buildExecutiveSummaryPdf, buildFutureState } = require('../services/exportBuilder');
const router = express.Router();

router.get('/projects/:projectId/export', analystRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const documentsResult = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query('SELECT * FROM dbo.Documents WHERE project_id=@pid ORDER BY generated_at DESC');
  const futureState = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query("SELECT TOP 1 content FROM dbo.AIInsights WHERE project_id=@pid AND type='future_state'");
  res.render('export/index', {
    title: 'Export',
    project: req.project,
    documents: documentsResult.recordset,
    futureStateInsight: futureState.recordset[0] || null,
  });
});

async function doExport(res, req, docType, bufferFn, filename) {
  try {
    const pool   = await getPool();
    const buffer = await bufferFn();
    const url    = await saveBuffer(buffer, filename, 'exports');
    const versionResult = await pool.request()
      .input('pid',  sql.UniqueIdentifier, req.params.projectId)
      .input('type', sql.NVarChar, docType)
      .query('SELECT ISNULL(MAX(version), 0) + 1 AS next_version FROM dbo.Documents WHERE project_id=@pid AND doc_type=@type');
    const version = versionResult.recordset[0].next_version || 1;
    await pool.request()
      .input('id',   sql.UniqueIdentifier, uuidv4())
      .input('pid',  sql.UniqueIdentifier, req.params.projectId)
      .input('type', sql.NVarChar, docType)
      .input('url',  sql.NVarChar, url)
      .input('uid',  sql.UniqueIdentifier, req.session.userId)
      .input('ver',  sql.Int, version)
      .query('INSERT INTO dbo.Documents (id, project_id, doc_type, file_url, generated_by, version) VALUES (@id, @pid, @type, @url, @uid, @ver)');

    const ext = filename.split('.').pop();
    const mimeMap = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    console.error(`[export/${docType}]`, err);
    req.flash('error', `Export failed: ${err.message}`);
    res.redirect(`/projects/${req.params.projectId}/export`);
  }
}

router.post('/projects/:projectId/export/brd', analystRequired, projectAccessRequired, (req, res) =>
  doExport(res, req, 'brd', () => buildBrd(req.params.projectId, req.project.name),
    `BRD_${req.project.name.replace(/\s+/g,'_')}.docx`)
);

router.post('/projects/:projectId/export/frd', analystRequired, projectAccessRequired, (req, res) =>
  doExport(res, req, 'frd', () => buildFrd(req.params.projectId, req.project.name),
    `FRD_${req.project.name.replace(/\s+/g,'_')}.docx`)
);

router.post('/projects/:projectId/export/risk-register', analystRequired, projectAccessRequired, (req, res) =>
  doExport(res, req, 'risk_register', () => buildRiskRegister(req.params.projectId, req.project.name),
    `Risk_Register_${req.project.name.replace(/\s+/g,'_')}.xlsx`)
);

router.post('/projects/:projectId/export/executive-summary', analystRequired, projectAccessRequired, (req, res) => {
  const format = req.body.format === 'pdf' ? 'pdf' : 'docx';
  if (format === 'pdf') {
    return doExport(res, req, 'executive_summary_pdf', () => buildExecutiveSummaryPdf(req.params.projectId, req.project),
      `Executive_Summary_${req.project.name.replace(/\s+/g,'_')}.pdf`);
  }
  return doExport(res, req, 'executive_summary', () => buildExecutiveSummary(req.params.projectId, req.project.name),
    `Executive_Summary_${req.project.name.replace(/\s+/g,'_')}.docx`);
});

router.post('/projects/:projectId/export/future-state', analystRequired, projectAccessRequired, async (req, res) => {
  const pool    = await getPool();
  const insRow  = await pool.request().input('pid', sql.UniqueIdentifier, req.params.projectId)
    .query("SELECT content FROM dbo.AIInsights WHERE project_id=@pid AND type='future_state'");
  const insight = insRow.recordset[0] ? JSON.parse(insRow.recordset[0].content) : null;
  doExport(res, req, 'future_state', () => buildFutureState(req.params.projectId, req.project.name, insight),
    `Future_State_${req.project.name.replace(/\s+/g,'_')}.docx`);
});

module.exports = router;
