'use strict';
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getPool, sql } = require('../config/database');
const { parseFile } = require('./fileParser');

const SOURCE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'sources');
const EXPORT_DIR = path.join(__dirname, '..', 'public', 'uploads', 'exports');
const ENTITY_TABLES = [
  'Requirements',
  'Stakeholders',
  'Processes',
  'Decisions',
  'Risks',
  'BusinessRules',
  'Systems',
  'KPIs',
];

function fileUrl(kind, filename) {
  return `/uploads/${kind}/${filename}`;
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .map(name => ({ name, path: path.join(dir, name) }))
      .filter(file => fs.statSync(file.path).isFile());
  } catch (_) {
    return [];
  }
}

function inferSourceType(ext) {
  const e = String(ext || '').toLowerCase().replace('.', '');
  if (e === 'pptx') return 'presentation';
  if (['xlsx', 'xls'].includes(e)) return 'spreadsheet';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(e)) return 'image';
  if (e === 'txt') return 'transcript';
  return 'document';
}

function displaySourceName(filename) {
  if (filename === '92a5e6bf-2518-491b-a1e6-3e295b3cd89e.docx') return 'Meeting_notes.docx';
  return filename;
}

async function collectDataHealth(poolArg) {
  const pool = poolArg || await getPool();
  const sourceFiles = listFiles(SOURCE_DIR).map(file => ({
    ...file,
    file_url: fileUrl('sources', file.name),
  }));
  const exportFiles = listFiles(EXPORT_DIR).map(file => ({
    ...file,
    file_url: fileUrl('exports', file.name),
  }));

  const projects = await pool.request().query('SELECT id, name, status, owner_id FROM dbo.Projects ORDER BY created_at DESC');
  const sources = await pool.request().query('SELECT id, project_id, name, file_url, ai_status, extraction_status FROM dbo.Sources ORDER BY created_at DESC');
  const documents = await pool.request().query('SELECT id, project_id, doc_type, file_url FROM dbo.Documents');
  const sourceUrls = new Set(sources.recordset.map(s => String(s.file_url || '').toLowerCase()).filter(Boolean));
  const documentUrls = new Set(documents.recordset.map(d => String(d.file_url || '').toLowerCase()).filter(Boolean));

  const orphanedProjects = await pool.request().query(`
    SELECT p.id, p.name, p.status, p.owner_id
    FROM dbo.Projects p
    WHERE NOT EXISTS (SELECT 1 FROM dbo.ProjectMembers pm WHERE pm.project_id = p.id)
  `);

  const missingOwnerMemberships = await pool.request().query(`
    SELECT p.id, p.name, p.status, p.owner_id
    FROM dbo.Projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM dbo.ProjectMembers pm
      WHERE pm.project_id = p.id AND pm.user_id = p.owner_id
    )
  `);

  const entityRowsMissingSource = [];
  for (const table of ENTITY_TABLES) {
    const result = await pool.request().query(`
      SELECT COUNT(*) AS cnt
      FROM dbo.${table} e
      LEFT JOIN dbo.Sources s ON s.id = e.source_id
      WHERE e.source_id IS NOT NULL AND s.id IS NULL
    `);
    const count = Number(result.recordset[0].cnt || 0);
    if (count) entityRowsMissingSource.push({ table, count });
  }

  return {
    projects: projects.recordset,
    sources: sources.recordset,
    localSourceFiles: sourceFiles,
    localExportFiles: exportFiles,
    sourceFilesWithoutRows: sourceFiles.filter(file => !sourceUrls.has(file.file_url.toLowerCase())),
    exportsWithoutDocuments: exportFiles.filter(file => !documentUrls.has(file.file_url.toLowerCase())),
    orphanedProjects: orphanedProjects.recordset,
    missingOwnerMemberships: missingOwnerMemberships.recordset,
    entityRowsMissingSource,
  };
}

async function repairOwnerMemberships(poolArg) {
  const pool = poolArg || await getPool();
  const result = await pool.request().query(`
    INSERT INTO dbo.ProjectMembers (id, project_id, user_id, role)
    SELECT NEWID(), p.id, p.owner_id, 'owner'
    FROM dbo.Projects p
    WHERE NOT EXISTS (
      SELECT 1
      FROM dbo.ProjectMembers pm
      WHERE pm.project_id = p.id AND pm.user_id = p.owner_id
    )
  `);
  return result.rowsAffected.reduce((sum, n) => sum + n, 0);
}

async function recoverMissingLocalSources(options = {}) {
  const pool = options.pool || await getPool();
  const dryRun = Boolean(options.dryRun);
  const health = await collectDataHealth(pool);
  const activeProjects = health.projects.filter(p => p.status !== 'archived');
  const totalSources = health.sources.length;
  const candidates = health.sourceFilesWithoutRows;
  const recovered = [];
  const skipped = [];

  if (!candidates.length) {
    return { recovered, skipped, reason: 'No unmatched local source files found.' };
  }
  if (activeProjects.length !== 1 || totalSources !== 0) {
    return {
      recovered,
      skipped: candidates.map(file => ({ file: file.name, reason: 'Recovery skipped because project/source context is ambiguous.' })),
      reason: 'Automatic recovery requires exactly one active project and zero source rows.',
    };
  }

  const project = activeProjects[0];
  for (const file of candidates) {
    const ext = path.extname(file.name).toLowerCase();
    const parsed = await parseFile(file.path, ext);
    const text = parsed.text || '';
    const metadata = parsed.metadata || {};
    const extractionStatus = text ? 'done' : metadata.extraction_method === 'ocr-needs-vision' ? 'pending' : 'failed';
    const source = {
      id: uuidv4(),
      project_id: project.id,
      name: displaySourceName(file.name),
      source_type: inferSourceType(ext),
      file_url: file.file_url,
      file_ext: ext,
      extracted_text: text || null,
      extraction_status: extractionStatus,
      ai_status: 'pending',
      metadata: JSON.stringify(metadata),
    };

    if (!dryRun) {
      await pool.request()
        .input('id', sql.UniqueIdentifier, source.id)
        .input('pid', sql.UniqueIdentifier, source.project_id)
        .input('name', sql.NVarChar, source.name)
        .input('stype', sql.NVarChar, source.source_type)
        .input('furl', sql.NVarChar, source.file_url)
        .input('fext', sql.NVarChar, source.file_ext)
        .input('text', sql.NVarChar, source.extracted_text)
        .input('estatus', sql.NVarChar, source.extraction_status)
        .input('astatus', sql.NVarChar, source.ai_status)
        .input('parts', sql.NVarChar, JSON.stringify([]))
        .input('meta', sql.NVarChar, source.metadata)
        .query(`
          INSERT INTO dbo.Sources
            (id, project_id, name, source_type, file_url, file_ext, extracted_text, extraction_status, ai_status, participants, metadata)
          VALUES
            (@id, @pid, @name, @stype, @furl, @fext, @text, @estatus, @astatus, @parts, @meta)
        `);
    }
    recovered.push({
      id: source.id,
      project_id: source.project_id,
      project_name: project.name,
      name: source.name,
      file_url: source.file_url,
      extraction_status: source.extraction_status,
      ai_status: source.ai_status,
      word_count: metadata.word_count || 0,
      dry_run: dryRun,
    });
  }

  return { recovered, skipped, reason: null };
}

module.exports = {
  collectDataHealth,
  repairOwnerMemberships,
  recoverMissingLocalSources,
};
