'use strict';
const { getPool, sql } = require('../config/database');

const ENTITY_TABLES = {
  requirements:   'Requirements',
  stakeholders:   'Stakeholders',
  processes:      'Processes',
  decisions:      'Decisions',
  risks:          'Risks',
  business_rules: 'BusinessRules',
  systems:        'Systems',
  kpis:           'KPIs',
};

/**
 * Build graph edges for a project by inferring relationships through
 * text-matching entity names across types. Clears existing edges first.
 */
async function buildGraphEdges(projectId) {
  const pool = await getPool();

  // Clear existing edges
  await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .query('DELETE FROM dbo.GraphEdges WHERE project_id = @pid');

  // Load all entities
  const entities = {};
  for (const [type, table] of Object.entries(ENTITY_TABLES)) {
    const r = await pool.request()
      .input('pid', sql.UniqueIdentifier, projectId)
      .query(`SELECT id, title, name, description FROM dbo.${table} WHERE project_id = @pid`);
    entities[type] = r.recordset.map(row => ({
      id:   row.id,
      text: [row.title || '', row.name || '', row.description || ''].join(' ').toLowerCase(),
    }));
  }

  const edges = [];

  // Stakeholder owns Requirement
  for (const s of entities.stakeholders) {
    const nameToken = s.text.split(' ')[0]; // first word of name
    for (const r of entities.requirements) {
      if (r.text.includes(nameToken)) {
        edges.push({ src: s.id, srcType: 'stakeholders', tgt: r.id, tgtType: 'requirements', rel: 'owns' });
      }
    }
  }

  // Risk impacts Process
  for (const r of entities.risks) {
    for (const p of entities.processes) {
      const pName = (p.text.split(' ')[0] || '').toLowerCase();
      if (r.text.includes(pName) && pName.length > 3) {
        edges.push({ src: r.id, srcType: 'risks', tgt: p.id, tgtType: 'processes', rel: 'impacts' });
      }
    }
  }

  // Process uses System
  for (const p of entities.processes) {
    for (const s of entities.systems) {
      const sName = (s.text.split(' ')[0] || '').toLowerCase();
      if (p.text.includes(sName) && sName.length > 3) {
        edges.push({ src: p.id, srcType: 'processes', tgt: s.id, tgtType: 'systems', rel: 'uses' });
      }
    }
  }

  // Decision shapes Requirement
  for (const d of entities.decisions) {
    for (const r of entities.requirements) {
      const words = d.text.split(/\s+/).filter(w => w.length > 5).slice(0, 5);
      if (words.some(w => r.text.includes(w))) {
        edges.push({ src: d.id, srcType: 'decisions', tgt: r.id, tgtType: 'requirements', rel: 'shapes' });
      }
    }
  }

  // Batch insert edges
  for (const e of edges) {
    try {
      await pool.request()
        .input('pid',  sql.UniqueIdentifier, projectId)
        .input('snid', sql.NVarChar,         e.src)
        .input('snt',  sql.NVarChar,         e.srcType)
        .input('tnid', sql.NVarChar,         e.tgt)
        .input('tnt',  sql.NVarChar,         e.tgtType)
        .input('rel',  sql.NVarChar,         e.rel)
        .query(`
          INSERT INTO dbo.GraphEdges (project_id, source_node_id, source_node_type, target_node_id, target_node_type, relationship)
          VALUES (@pid, @snid, @snt, @tnid, @tnt, @rel)
        `);
    } catch (_) {}
  }

  return edges.length;
}

/**
 * Return Cytoscape.js elements format for a project's graph.
 */
async function getGraphElements(projectId) {
  const pool = await getPool();
  const elements = [];

  // Load nodes from all entity tables
  const nodeColors = {
    requirements:   '#6366f1', // indigo
    stakeholders:   '#06b6d4', // cyan
    processes:      '#22c55e', // green
    decisions:      '#f59e0b', // amber
    risks:          '#ef4444', // red
    business_rules: '#8b5cf6', // violet
    systems:        '#3b82f6', // blue
    kpis:           '#ec4899', // pink
  };

  for (const [type, table] of Object.entries(ENTITY_TABLES)) {
    const r = await pool.request()
      .input('pid', sql.UniqueIdentifier, projectId)
      .query(`SELECT id, title, name FROM dbo.${table} WHERE project_id = @pid`);
    for (const row of r.recordset) {
      elements.push({
        data: {
          id:    row.id,
          label: row.title || row.name || '?',
          type,
          color: nodeColors[type] || '#888',
        },
      });
    }
  }

  // Load edges
  const edges = await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .query('SELECT * FROM dbo.GraphEdges WHERE project_id = @pid');
  for (const e of edges.recordset) {
    elements.push({
      data: {
        id:     e.id,
        source: e.source_node_id,
        target: e.target_node_id,
        label:  e.relationship,
      },
    });
  }

  return elements;
}

module.exports = { buildGraphEdges, getGraphElements };
