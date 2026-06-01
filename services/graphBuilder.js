'use strict';
const crypto = require('crypto');
const { getPool, sql } = require('../config/database');

const ENTITY_TYPES = {
  requirements: {
    table: 'Requirements',
    label: 'Requirements',
    nameCol: 'title',
    color: '#6366f1',
    fields: 'id, title, description, priority, confidence, source_quote, created_at',
  },
  stakeholders: {
    table: 'Stakeholders',
    label: 'Stakeholders',
    nameCol: 'name',
    color: '#06b6d4',
    fields: 'id, name, role, organization, influence, interest, confidence, source_quote, created_at',
  },
  processes: {
    table: 'Processes',
    label: 'Processes',
    nameCol: 'name',
    color: '#22c55e',
    fields: 'id, name, description, steps, confidence, source_quote, created_at',
  },
  decisions: {
    table: 'Decisions',
    label: 'Decisions',
    nameCol: 'title',
    color: '#f59e0b',
    fields: 'id, title, description, rationale, decision_maker, status, confidence, source_quote, created_at',
  },
  risks: {
    table: 'Risks',
    label: 'Risks',
    nameCol: 'title',
    color: '#ef4444',
    fields: 'id, title, description, category, likelihood, impact, mitigation, owner, confidence, source_quote, created_at',
  },
  business_rules: {
    table: 'BusinessRules',
    label: 'Business Rules',
    nameCol: 'title',
    color: '#8b5cf6',
    fields: 'id, title, description, category, confidence, source_quote, created_at',
  },
  systems: {
    table: 'Systems',
    label: 'Systems',
    nameCol: 'name',
    color: '#3b82f6',
    fields: 'id, name, system_type, description, integrations, confidence, source_quote, created_at',
  },
  kpis: {
    table: 'KPIs',
    label: 'KPIs',
    nameCol: 'name',
    color: '#ec4899',
    fields: 'id, name, description, target_value, measurement_method, frequency, owner, confidence, source_quote, created_at',
  },
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'about', 'around', 'without',
  'system', 'systems', 'platform', 'platforms', 'process', 'processes', 'requirement', 'requirements',
  'project', 'meeting', 'team', 'current', 'future', 'conference', 'conferences', 'technology',
  'documentation', 'business', 'used', 'provides', 'supports', 'supporting', 'front', 'account',
  'management', 'individual', 'small', 'large', 'group', 'groups', 'self', 'service', 'known',
]);

function parseJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function words(value) {
  return norm(value).split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function canonicalKey(type, label) {
  return `${type}:${norm(label) || 'unknown'}`;
}

function graphNodeId(type, label) {
  const hash = crypto.createHash('sha1').update(canonicalKey(type, label)).digest('hex').slice(0, 24);
  return `${type.slice(0, 3)}_${hash}`;
}

function textFor(entity) {
  return [
    entity.label,
    entity.description,
    entity.source_quote,
    entity.role,
    entity.organization,
    entity.owner,
    entity.decision_maker,
    entity.rationale,
    entity.category,
    entity.status,
    entity.system_type,
    Array.isArray(entity.integrations) ? entity.integrations.join(' ') : entity.integrations,
    Array.isArray(entity.steps) ? entity.steps.map(s => `${s.actor || ''} ${s.action || ''}`).join(' ') : entity.steps,
  ].filter(Boolean).join(' ');
}

function entityUrl(projectId, type, id) {
  return `/projects/${projectId}/${type}/${id}`;
}

async function loadEntities(projectId) {
  const pool = await getPool();
  const out = {};
  for (const [type, cfg] of Object.entries(ENTITY_TYPES)) {
    const result = await pool.request()
      .input('pid', sql.UniqueIdentifier, projectId)
      .query(`SELECT ${cfg.fields} FROM dbo.${cfg.table} WHERE project_id = @pid ORDER BY created_at`);
    out[type] = result.recordset.map(row => {
      const label = row[cfg.nameCol] || row.title || row.name || 'Untitled';
      const entity = {
        ...row,
        type,
        label,
        canonical_key: canonicalKey(type, label),
        node_id: graphNodeId(type, label),
        integrations: type === 'systems' ? parseJson(row.integrations, []) : row.integrations,
        steps: type === 'processes' ? parseJson(row.steps, []) : row.steps,
      };
      entity.searchText = norm(textFor(entity));
      entity.tokens = new Set(words(textFor(entity)));
      return entity;
    });
  }
  return out;
}

function collapseNodes(projectId, entities) {
  const byKey = new Map();
  for (const [type, rows] of Object.entries(entities)) {
    for (const row of rows) {
      const key = row.node_id;
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: key,
          type,
          label: row.label,
          color: ENTITY_TYPES[type].color,
          description: row.description || row.role || row.rationale || row.mitigation || row.target_value || '',
          source_quote: row.source_quote || '',
          count: 0,
          url: entityUrl(projectId, type, row.id),
          record_ids: [],
          records: [],
        });
      }
      const node = byKey.get(key);
      node.count += 1;
      node.record_ids.push(row.id);
      node.records.push(row);
      if (!node.description && row.description) node.description = row.description;
      if (!node.source_quote && row.source_quote) node.source_quote = row.source_quote;
    }
  }
  return byKey;
}

function exactNameMention(subject, object) {
  const label = norm(object.label);
  if (!label || label.length < 4) return false;
  return subject.searchText.includes(label);
}

function tokenOverlap(a, b) {
  const aWords = [...a.tokens].filter(w => w.length > 3);
  const bWords = [...b.tokens].filter(w => w.length > 3);
  if (!aWords.length || !bWords.length) return 0;
  const bSet = new Set(bWords);
  return aWords.filter(w => bSet.has(w)).length;
}

function hasBusinessOverlap(a, b, minimum = 2) {
  if (exactNameMention(a, b) || exactNameMention(b, a)) return true;
  return tokenOverlap(a, b) >= minimum;
}

function systemIntegrationMentions(system, otherSystem) {
  const integrations = Array.isArray(system.integrations) ? system.integrations : [];
  return integrations.some(name => norm(name) === norm(otherSystem.label) || norm(name).includes(norm(otherSystem.label)) || norm(otherSystem.label).includes(norm(name)));
}

function addEdge(edges, source, target, relationship, reason, weight = 1) {
  if (!source || !target || source.node_id === target.node_id) return;
  const key = `${source.node_id}|${target.node_id}|${relationship}`;
  if (edges.has(key)) return;
  edges.set(key, {
    source: source.node_id,
    sourceType: source.type,
    target: target.node_id,
    targetType: target.type,
    relationship,
    reason: reason || relationship,
    weight,
  });
}

function inferRelationships(entities) {
  const edges = new Map();
  const reqs = entities.requirements || [];
  const systems = entities.systems || [];
  const processes = entities.processes || [];
  const stakeholders = entities.stakeholders || [];
  const risks = entities.risks || [];
  const decisions = entities.decisions || [];
  const rules = entities.business_rules || [];
  const kpis = entities.kpis || [];

  for (const req of reqs) {
    for (const system of systems) {
      if (exactNameMention(req, system) || tokenOverlap(req, system) >= 2) addEdge(edges, req, system, 'impacts', 'Requirement text mentions or strongly overlaps this system.', 3);
    }
    for (const process of processes) {
      if (hasBusinessOverlap(req, process, 2)) addEdge(edges, req, process, 'changes', 'Requirement overlaps this business process.', 2);
    }
    for (const stakeholder of stakeholders) {
      const ownerText = norm([stakeholder.label, stakeholder.role, stakeholder.organization].join(' '));
      if (exactNameMention(req, stakeholder) || words(ownerText).some(w => req.searchText.includes(w) && w.length > 4)) {
        addEdge(edges, req, stakeholder, 'owned by', 'Requirement mentions this stakeholder or their role.', 2);
      }
    }
    for (const risk of risks) {
      if (hasBusinessOverlap(req, risk, 2)) addEdge(edges, req, risk, 'creates risk', 'Requirement overlaps this risk.', 2);
    }
    for (const decision of decisions) {
      if (hasBusinessOverlap(req, decision, 2)) addEdge(edges, decision, req, 'supports', 'Decision supports or shapes this requirement.', 2);
    }
    for (const rule of rules) {
      if (hasBusinessOverlap(req, rule, 2)) addEdge(edges, rule, req, 'supports', 'Business rule supports this requirement.', 1);
    }
    for (const kpi of kpis) {
      if (hasBusinessOverlap(req, kpi, 2)) addEdge(edges, req, kpi, 'measured by', 'Requirement overlaps this KPI.', 1);
    }
  }

  for (const process of processes) {
    for (const system of systems) {
      if (hasBusinessOverlap(process, system, 1)) addEdge(edges, process, system, 'uses', 'Process mentions or depends on this system.', 3);
    }
    for (const stakeholder of stakeholders) {
      if (exactNameMention(process, stakeholder) || tokenOverlap(process, stakeholder) >= 1) {
        addEdge(edges, stakeholder, process, 'participates in', 'Stakeholder appears in the process context.', 1);
      }
    }
  }

  for (const risk of risks) {
    for (const system of systems) {
      if (exactNameMention(risk, system) || tokenOverlap(risk, system) >= 2) addEdge(edges, risk, system, 'impacts', 'Risk mentions or strongly overlaps this system.', 2);
    }
    for (const process of processes) {
      if (hasBusinessOverlap(risk, process, 2)) addEdge(edges, risk, process, 'impacts', 'Risk overlaps this process.', 2);
    }
    for (const stakeholder of stakeholders) {
      if (exactNameMention(risk, stakeholder) || norm(risk.owner) === norm(stakeholder.label)) {
        addEdge(edges, risk, stakeholder, 'owned by', 'Risk owner or text references this stakeholder.', 2);
      }
    }
  }

  for (const system of systems) {
    for (const other of systems) {
      if (system.id === other.id) continue;
      if (systemIntegrationMentions(system, other)) addEdge(edges, system, other, 'depends on', 'System integration references this system.', 3);
    }
  }

  return [...edges.values()];
}

async function buildGraphEdges(projectId) {
  const pool = await getPool();
  const entities = await loadEntities(projectId);
  const inferred = inferRelationships(entities);

  await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .query('DELETE FROM dbo.GraphEdges WHERE project_id = @pid');

  for (const edge of inferred) {
    await pool.request()
      .input('pid', sql.UniqueIdentifier, projectId)
      .input('snid', sql.NVarChar, edge.source)
      .input('snt', sql.NVarChar, edge.sourceType)
      .input('tnid', sql.NVarChar, edge.target)
      .input('tnt', sql.NVarChar, edge.targetType)
      .input('rel', sql.NVarChar, edge.relationship)
      .input('weight', sql.Int, edge.weight || 1)
      .query(`
        INSERT INTO dbo.GraphEdges (project_id, source_node_id, source_node_type, target_node_id, target_node_type, relationship, weight)
        VALUES (@pid, @snid, @snt, @tnid, @tnt, @rel, @weight)
      `);
  }

  return inferred.length;
}

async function ensureGraphEdges(projectId) {
  const pool = await getPool();
  const counts = await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.GraphEdges WHERE project_id=@pid) AS edge_count,
        (SELECT COUNT(*) FROM dbo.Requirements WHERE project_id=@pid) +
        (SELECT COUNT(*) FROM dbo.Systems WHERE project_id=@pid) +
        (SELECT COUNT(*) FROM dbo.Processes WHERE project_id=@pid) +
        (SELECT COUNT(*) FROM dbo.Stakeholders WHERE project_id=@pid) +
        (SELECT COUNT(*) FROM dbo.Risks WHERE project_id=@pid) +
        (SELECT COUNT(*) FROM dbo.Decisions WHERE project_id=@pid) AS entity_count
    `);
  const row = counts.recordset[0] || { edge_count: 0, entity_count: 0 };
  if (Number(row.entity_count || 0) > 0 && Number(row.edge_count || 0) === 0) {
    await buildGraphEdges(projectId);
  }
}

async function loadStoredEdges(projectId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('pid', sql.UniqueIdentifier, projectId)
    .query('SELECT * FROM dbo.GraphEdges WHERE project_id=@pid ORDER BY relationship');
  return result.recordset;
}

async function getGraphElements(projectId) {
  await ensureGraphEdges(projectId);
  const entities = await loadEntities(projectId);
  const nodes = collapseNodes(projectId, entities);
  const storedEdges = await loadStoredEdges(projectId);
  const elements = [];

  for (const node of nodes.values()) {
    elements.push({
      data: {
        id: node.id,
        label: node.count > 1 ? `${node.label} (${node.count})` : node.label,
        title: node.label,
        type: node.type,
        typeLabel: ENTITY_TYPES[node.type].label,
        color: node.color,
        description: node.description,
        source_quote: node.source_quote,
        url: node.url,
        count: node.count,
      },
    });
  }

  for (const edge of storedEdges) {
    if (!nodes.has(edge.source_node_id) || !nodes.has(edge.target_node_id)) continue;
    elements.push({
      data: {
        id: String(edge.id),
        source: edge.source_node_id,
        target: edge.target_node_id,
        label: edge.relationship,
        relationship: edge.relationship,
        weight: edge.weight || 1,
      },
    });
  }

  return {
    elements,
    stats: {
      node_count: nodes.size,
      edge_count: elements.filter(e => e.data.source).length,
    },
  };
}

function relatedForRequirement(req, edges, nodes, targetType, relationships) {
  const rels = new Set(relationships || []);
  const out = new Map();
  for (const edge of edges) {
    const touchesReq = edge.source_node_id === req.node_id || edge.target_node_id === req.node_id;
    if (!touchesReq) continue;
    if (rels.size && !rels.has(edge.relationship)) continue;
    const otherId = edge.source_node_id === req.node_id ? edge.target_node_id : edge.source_node_id;
    const node = nodes.get(otherId);
    if (!node || node.type !== targetType) continue;
    out.set(otherId, node);
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function getTraceabilityRows(projectId) {
  await ensureGraphEdges(projectId);
  const entities = await loadEntities(projectId);
  const nodes = collapseNodes(projectId, entities);
  const edges = await loadStoredEdges(projectId);
  const requirements = entities.requirements || [];

  return requirements.map(req => {
    const systems = relatedForRequirement(req, edges, nodes, 'systems', ['impacts', 'uses', 'depends on']);
    const processes = relatedForRequirement(req, edges, nodes, 'processes', ['changes', 'uses']);
    const stakeholders = relatedForRequirement(req, edges, nodes, 'stakeholders', ['owned by', 'participates in']);
    const risks = relatedForRequirement(req, edges, nodes, 'risks', ['creates risk', 'impacts']);
    const decisions = relatedForRequirement(req, edges, nodes, 'decisions', ['supports']);
    return {
      id: req.id,
      title: req.label,
      priority: req.priority || 'medium',
      evidence: req.source_quote || req.description || '',
      url: entityUrl(projectId, 'requirements', req.id),
      systems,
      processes,
      stakeholders,
      risks,
      decisions,
      unmapped: !(systems.length || processes.length || stakeholders.length || risks.length || decisions.length),
    };
  });
}

module.exports = {
  buildGraphEdges,
  ensureGraphEdges,
  getGraphElements,
  getTraceabilityRows,
};
