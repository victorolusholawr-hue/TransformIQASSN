'use strict';
const express = require('express');
const { getPool, sql }    = require('../config/database');
const { loginRequired }   = require('../middleware/auth');
const { projectAccessRequired } = require('../middleware/projectAccess');
const { getGraphElements } = require('../services/graphBuilder');
const router = express.Router();

router.get('/projects/:projectId/graph', loginRequired, projectAccessRequired, async (req, res) => {
  res.render('graph/view', { title: 'Knowledge Graph', project: req.project });
});

router.get('/projects/:projectId/graph/data', loginRequired, projectAccessRequired, async (req, res) => {
  const elements = await getGraphElements(req.params.projectId);
  res.json({ elements });
});

router.get('/projects/:projectId/traceability', loginRequired, projectAccessRequired, async (req, res) => {
  const pool = await getPool();
  const pid  = req.params.projectId;

  const reqs = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query('SELECT id, title FROM dbo.Requirements WHERE project_id=@pid');
  const syss = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query('SELECT id, name FROM dbo.Systems WHERE project_id=@pid');
  const edges = await pool.request().input('pid', sql.UniqueIdentifier, pid)
    .query("SELECT source_node_id, target_node_id FROM dbo.GraphEdges WHERE project_id=@pid");

  const edgeSet = new Set(edges.recordset.map(e => `${e.source_node_id}:${e.target_node_id}`));

  res.render('graph/traceability', {
    title:        'Traceability Matrix',
    project:      req.project,
    requirements: reqs.recordset,
    systems:      syss.recordset,
    edgeSet,
  });
});

module.exports = router;
