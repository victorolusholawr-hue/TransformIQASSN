'use strict';

const { sql } = require('../config/database');

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

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

async function countEntitiesForSource(pool, sourceId) {
  let count = 0;
  for (const table of ENTITY_TABLES) {
    const result = await pool.request()
      .input('sid', sql.UniqueIdentifier, sourceId)
      .query(`SELECT COUNT(*) AS cnt FROM dbo.${table} WHERE source_id=@sid`);
    count += Number(result.recordset[0].cnt || 0);
  }
  return count;
}

async function markSourceExtracted(pool, source) {
  const metadata = parseJson(source.metadata, {});
  delete metadata.ai_error;
  metadata.ai_reconciled_at = new Date().toISOString();

  await pool.request()
    .input('id', sql.UniqueIdentifier, source.id)
    .input('meta', sql.NVarChar, JSON.stringify(metadata))
    .query(`
      UPDATE dbo.Sources
      SET ai_status='done',
          extraction_status = CASE
            WHEN extraction_status='failed' THEN 'done'
            ELSE extraction_status
          END,
          metadata=@meta
      WHERE id=@id
    `);
}

async function reconcileProjectSourceStatuses(pool, projectId) {
  const result = await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .query(`
      SELECT id, ai_status, extraction_status, metadata
      FROM dbo.Sources
      WHERE project_id=@pid AND ISNULL(ai_status, 'pending') <> 'done'
    `);

  for (const source of result.recordset) {
    const entityCount = await countEntitiesForSource(pool, source.id);
    if (entityCount > 0) {
      await markSourceExtracted(pool, source);
    }
  }
}

async function reconcileSingleSourceStatus(pool, sourceId) {
  const result = await pool.request()
    .input('id', sql.UniqueIdentifier, sourceId)
    .query('SELECT id, ai_status, extraction_status, metadata FROM dbo.Sources WHERE id=@id');
  const source = result.recordset[0];
  if (!source || source.ai_status === 'done') return;

  const entityCount = await countEntitiesForSource(pool, source.id);
  if (entityCount > 0) {
    await markSourceExtracted(pool, source);
  }
}

module.exports = {
  reconcileProjectSourceStatuses,
  reconcileSingleSourceStatus,
};
