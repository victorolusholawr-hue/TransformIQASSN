'use strict';
const { getPool, sql } = require('../config/database');

// ── Helpers ───────────────────────────────────────────────────
async function loadEntities(projectId) {
  const pool = await getPool();
  const q    = (table) =>
    pool.request()
      .input('pid', sql.UniqueIdentifier, projectId)
      .query(`SELECT * FROM dbo.${table} WHERE project_id = @pid ORDER BY created_at`);

  const [reqs, stakes, procs, decs, risks, rules, systems, kpis] = await Promise.all([
    q('Requirements'), q('Stakeholders'), q('Processes'),
    q('Decisions'),    q('Risks'),        q('BusinessRules'),
    q('Systems'),      q('KPIs'),
  ]);

  return {
    requirements:   reqs.recordset,
    stakeholders:   stakes.recordset,
    processes:      procs.recordset,
    decisions:      decs.recordset,
    risks:          risks.recordset,
    business_rules: rules.recordset,
    systems:        systems.recordset,
    kpis:           kpis.recordset,
  };
}

// ── BRD (.docx) ───────────────────────────────────────────────
async function buildBrd(projectId, projectName) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const data = await loadEntities(projectId);

  function section(title, items, fields) {
    const paras = [new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 })];
    if (!items.length) {
      paras.push(new Paragraph({ children: [new TextRun({ text: 'None extracted.', italics: true })] }));
    }
    for (const item of items) {
      paras.push(new Paragraph({ text: item.title || item.name || '', heading: HeadingLevel.HEADING_2 }));
      for (const f of fields) {
        if (item[f]) {
          paras.push(new Paragraph({
            children: [
              new TextRun({ text: `${f.replace(/_/g, ' ')}: `, bold: true }),
              new TextRun({ text: String(item[f]) }),
            ],
          }));
        }
      }
    }
    return paras;
  }

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: `Business Requirements Document`, heading: HeadingLevel.TITLE }),
        new Paragraph({ text: projectName, heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: `Generated: ${new Date().toDateString()}` }),
        ...section('Requirements',    data.requirements,   ['req_type', 'priority', 'status', 'description']),
        ...section('Processes',       data.processes,      ['description']),
        ...section('Stakeholders',    data.stakeholders,   ['role', 'organization', 'influence', 'interest']),
        ...section('Decisions',       data.decisions,      ['status', 'decision_maker', 'rationale']),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

// ── FRD (.docx) ───────────────────────────────────────────────
async function buildFrd(projectId, projectName) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const data = await loadEntities(projectId);

  const children = [
    new Paragraph({ text: 'Functional Requirements Document', heading: HeadingLevel.TITLE }),
    new Paragraph({ text: projectName }),
    new Paragraph({ text: `Generated: ${new Date().toDateString()}` }),
    new Paragraph({ text: 'Functional Requirements', heading: HeadingLevel.HEADING_1 }),
  ];

  const functional = data.requirements.filter(r => r.req_type === 'functional');
  for (const r of functional) {
    children.push(new Paragraph({ text: r.title, heading: HeadingLevel.HEADING_2 }));
    if (r.description) children.push(new Paragraph({ text: r.description }));
    if (r.priority)    children.push(new Paragraph({ children: [new TextRun({ text: 'Priority: ', bold: true }), new TextRun({ text: r.priority })] }));
  }

  children.push(new Paragraph({ text: 'Systems', heading: HeadingLevel.HEADING_1 }));
  for (const s of data.systems) {
    children.push(new Paragraph({ text: s.name, heading: HeadingLevel.HEADING_2 }));
    if (s.description) children.push(new Paragraph({ text: s.description }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── Risk Register (.xlsx) ─────────────────────────────────────
async function buildRiskRegister(projectId, projectName) {
  const ExcelJS = require('exceljs');
  const data    = await loadEntities(projectId);
  const wb      = new ExcelJS.Workbook();
  const ws      = wb.addWorksheet('Risk Register');

  ws.columns = [
    { header: 'Title',       key: 'title',      width: 35 },
    { header: 'Category',    key: 'category',   width: 18 },
    { header: 'Description', key: 'description',width: 45 },
    { header: 'Likelihood',  key: 'likelihood', width: 14 },
    { header: 'Impact',      key: 'impact',     width: 12 },
    { header: 'Score',       key: 'score',      width: 10 },
    { header: 'Mitigation',  key: 'mitigation', width: 40 },
    { header: 'Owner',       key: 'owner',      width: 20 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF72246C' } };
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const r of data.risks) {
    const score = (r.likelihood || 0) * (r.impact || 0);
    const row   = ws.addRow({ ...r, score });
    if (score >= 15) row.getCell('score').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEF4444' } };
    else if (score >= 9) row.getCell('score').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF59E0B' } };
  }

  ws.autoFilter = { from: 'A1', to: 'H1' };
  return wb.xlsx.writeBuffer();
}

// ── Executive Summary (.docx) ─────────────────────────────────
async function buildExecutiveSummary(projectId, projectName) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const data = await loadEntities(projectId);

  const children = [
    new Paragraph({ text: 'Executive Summary', heading: HeadingLevel.TITLE }),
    new Paragraph({ text: projectName }),
    new Paragraph({ text: `Generated: ${new Date().toDateString()}` }),
    new Paragraph({ text: 'Overview', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      children: [
        new TextRun({ text: `This transformation programme has identified ` }),
        new TextRun({ text: String(data.requirements.length), bold: true }),
        new TextRun({ text: ` requirements, ` }),
        new TextRun({ text: String(data.risks.length), bold: true }),
        new TextRun({ text: ` risks, and ` }),
        new TextRun({ text: String(data.stakeholders.length), bold: true }),
        new TextRun({ text: ` stakeholders across ` }),
        new TextRun({ text: String(data.processes.length), bold: true }),
        new TextRun({ text: ` business processes.` }),
      ],
    }),
    new Paragraph({ text: 'Top Risks', heading: HeadingLevel.HEADING_1 }),
  ];

  const topRisks = data.risks
    .sort((a, b) => ((b.likelihood || 0) * (b.impact || 0)) - ((a.likelihood || 0) * (a.impact || 0)))
    .slice(0, 5);
  for (const r of topRisks) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: r.title, bold: true }),
        new TextRun({ text: ` — Score: ${(r.likelihood || 0) * (r.impact || 0)} (L:${r.likelihood} × I:${r.impact})` }),
      ],
    }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildExecutiveSummaryPdf(projectId, project) {
  const puppeteer = require('puppeteer');
  const data = await loadEntities(projectId);
  const now = new Date();
  const stats = {
    requirements: data.requirements.length,
    stakeholders: data.stakeholders.length,
    processes: data.processes.length,
    decisions: data.decisions.length,
    risks: data.risks.length,
    business_rules: data.business_rules.length,
    systems: data.systems.length,
    kpis: data.kpis.length,
  };
  const topReqs = data.requirements
    .filter(r => r.priority === 'high')
    .slice(0, 8);
  const topRisks = data.risks
    .sort((a, b) => ((b.likelihood || 1) * (b.impact || 1)) - ((a.likelihood || 1) * (a.impact || 1)))
    .slice(0, 8);

  const statRows = Object.entries(stats).map(([key, count]) => `
    <tr><td>${escapeHtml(key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</td><td>${count}</td></tr>
  `).join('');
  const reqItems = topReqs.map(req => `
    <li><strong>${escapeHtml(req.title)}</strong>${req.description ? `: ${escapeHtml(String(req.description).slice(0, 200))}` : ''}</li>
  `).join('');
  const riskRows = topRisks.map(r => {
    const score = (r.likelihood || 1) * (r.impact || 1);
    return `
      <tr>
        <td>${escapeHtml(r.title)}</td>
        <td>${score}</td>
        <td>${escapeHtml(r.category || '-')}</td>
        <td>${escapeHtml(r.mitigation ? String(r.mitigation).slice(0, 100) : '-')}</td>
      </tr>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1a1523; margin: 2cm; }
    h1 { color: #72246c; font-size: 20pt; border-bottom: 2px solid #72246c; padding-bottom: 6pt; }
    h2 { color: #1a1523; font-size: 13pt; margin-top: 18pt; }
    table { width: 100%; border-collapse: collapse; margin: 8pt 0; font-size: 10pt; }
    th { background: #72246c; color: #fff; padding: 5pt 8pt; text-align: left; }
    td { padding: 4pt 8pt; border: 1px solid #e2dde8; }
    tr:nth-child(even) td { background: #f5f4f7; }
    .meta { color: #7a6e85; font-size: 9pt; }
    .tagline { font-style: italic; color: #7a6e85; margin-bottom: 20pt; }
  </style>
</head>
<body>
  <h1>Executive Summary</h1>
  <p class="tagline">From conversations to clarity. From clarity to transformation.</p>
  <p><strong>Project:</strong> ${escapeHtml(project.name)}</p>
  <p><strong>Date:</strong> ${escapeHtml(now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}</p>
  ${project.description ? `<p>${escapeHtml(project.description)}</p>` : ''}
  <h2>Knowledge Summary</h2>
  <table><thead><tr><th>Entity Type</th><th>Count</th></tr></thead><tbody>${statRows}</tbody></table>
  ${reqItems ? `<h2>High Priority Requirements</h2><ul>${reqItems}</ul>` : ''}
  ${riskRows ? `<h2>Top Risks</h2><table><thead><tr><th>Risk</th><th>Score</th><th>Category</th><th>Mitigation</th></tr></thead><tbody>${riskRows}</tbody></table>` : ''}
  <p class="meta" style="margin-top:24pt;">Generated by TransformIQ on ${escapeHtml(now.toISOString().slice(0, 16).replace('T', ' '))} UTC</p>
</body>
</html>`;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' } });
  } finally {
    await browser.close();
  }
}

// ── Future State (.docx) ──────────────────────────────────────
async function buildFutureState(projectId, projectName, insight) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const children = [
    new Paragraph({ text: 'Future State Scenarios', heading: HeadingLevel.TITLE }),
    new Paragraph({ text: projectName }),
    new Paragraph({ text: `Generated: ${new Date().toDateString()}` }),
  ];

  if (insight && (insight.overview || insight.narrative)) {
    children.push(new Paragraph({ text: 'Vision Overview', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: insight.overview || insight.narrative }));
  }

  if (insight && Array.isArray(insight.key_transformations)) {
    children.push(new Paragraph({ text: 'Key Transformations', heading: HeadingLevel.HEADING_1 }));
    for (const t of insight.key_transformations) {
      if (t.title) children.push(new Paragraph({ text: t.title, heading: HeadingLevel.HEADING_2 }));
      if (t.description) children.push(new Paragraph({ text: t.description }));
      if (t.business_value) {
        children.push(new Paragraph({ children: [new TextRun({ text: 'Business Value: ', bold: true }), new TextRun({ text: t.business_value })] }));
      }
    }
  }

  if (insight && Array.isArray(insight.process_changes)) {
    children.push(new Paragraph({ text: 'Process Changes', heading: HeadingLevel.HEADING_1 }));
    for (const pc of insight.process_changes) {
      if (pc.process_name) children.push(new Paragraph({ text: pc.process_name, heading: HeadingLevel.HEADING_2 }));
      if (pc.current_state) children.push(new Paragraph({ children: [new TextRun({ text: 'Current State: ', bold: true }), new TextRun({ text: pc.current_state })] }));
      if (pc.future_state) children.push(new Paragraph({ children: [new TextRun({ text: 'Future State: ', bold: true }), new TextRun({ text: pc.future_state })] }));
      for (const change of (pc.key_changes || [])) children.push(new Paragraph({ text: change, bullet: { level: 0 } }));
    }
  }

  if (insight && Array.isArray(insight.system_changes)) {
    children.push(new Paragraph({ text: 'System Changes', heading: HeadingLevel.HEADING_1 }));
    for (const sc of insight.system_changes) {
      children.push(new Paragraph({ children: [
        new TextRun({ text: sc.system_name || 'System', bold: true }),
        new TextRun({ text: ` (${sc.change_type || 'change'}) - ${sc.description || ''}` }),
      ] }));
    }
  }

  if (insight && Array.isArray(insight.process_maps)) {
    children.push(new Paragraph({ text: 'Future State Process Maps', heading: HeadingLevel.HEADING_1 }));
    for (const pm of insight.process_maps) {
      if (pm.process_name) children.push(new Paragraph({ text: pm.process_name, heading: HeadingLevel.HEADING_2 }));
      if (pm.mermaid) children.push(new Paragraph({ text: pm.mermaid }));
    }
  } else if (insight && Array.isArray(insight.scenarios)) {
    children.push(new Paragraph({ text: 'Scenarios', heading: HeadingLevel.HEADING_1 }));
    for (const s of insight.scenarios) {
      if (s.title) children.push(new Paragraph({ text: s.title, heading: HeadingLevel.HEADING_2 }));
      if (s.description) children.push(new Paragraph({ text: s.description }));
    }
  }

  if (insight && Array.isArray(insight.critical_success_factors)) {
    children.push(new Paragraph({ text: 'Critical Success Factors', heading: HeadingLevel.HEADING_1 }));
    for (const f of insight.critical_success_factors) children.push(new Paragraph({ text: f, bullet: { level: 0 } }));
  }

  if (insight && Array.isArray(insight.recommended_next_steps)) {
    children.push(new Paragraph({ text: 'Recommended Next Steps', heading: HeadingLevel.HEADING_1 }));
    for (const s of insight.recommended_next_steps) children.push(new Paragraph({ text: s, bullet: { level: 0 } }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { buildBrd, buildFrd, buildRiskRegister, buildExecutiveSummary, buildExecutiveSummaryPdf, buildFutureState };
