'use strict';
const express = require('express');
const { loginRequired } = require('../middleware/auth');
const { projectAccessRequired } = require('../middleware/projectAccess');
const { ensureGraphEdges, getGraphElements, getTraceabilityRows } = require('../services/graphBuilder');
const router = express.Router();

router.get('/projects/:projectId/graph', loginRequired, projectAccessRequired, async (req, res) => {
  try {
    await ensureGraphEdges(req.params.projectId);
    res.render('graph/view', { title: 'Business Impact Map', project: req.project });
  } catch (err) {
    console.error('[graph/view]', err);
    req.flash('error', 'Failed to prepare the business impact map.');
    res.redirect(`/projects/${req.params.projectId}`);
  }
});

router.get('/projects/:projectId/graph/data', loginRequired, projectAccessRequired, async (req, res) => {
  try {
    const graph = await getGraphElements(req.params.projectId);
    res.json(graph);
  } catch (err) {
    console.error('[graph/data]', err);
    res.status(500).json({ error: 'Failed to load graph data.' });
  }
});

async function renderTraceability(req, res) {
  try {
    const rows = await getTraceabilityRows(req.params.projectId);
    res.render('graph/traceability', {
      title: 'Requirements Traceability',
      project: req.project,
      rows,
    });
  } catch (err) {
    console.error('[traceability]', err);
    req.flash('error', 'Failed to load traceability.');
    res.redirect(`/projects/${req.params.projectId}`);
  }
}

router.get('/projects/:projectId/traceability', loginRequired, projectAccessRequired, renderTraceability);
router.get('/projects/:projectId/graph/traceability', loginRequired, projectAccessRequired, renderTraceability);
router.get('/projects/:projectId/graph/matrix', loginRequired, projectAccessRequired, renderTraceability);

module.exports = router;
