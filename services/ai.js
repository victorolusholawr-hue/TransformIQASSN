'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { getPool, sql } = require('../config/database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// ── Extraction system prompt (mirrors TransformIQ Python SYSTEM_PROMPT) ──────
const EXTRACTION_SYSTEM_PROMPT = `You are an expert Business Analyst AI. Extract structured entities from the provided source text.

Return a single valid JSON object with these top-level keys (omit any key if no entities found):
{
  "requirements": [...],
  "stakeholders": [...],
  "processes": [...],
  "decisions": [...],
  "risks": [...],
  "business_rules": [...],
  "systems": [...],
  "kpis": [...]
}

ENTITY SCHEMAS:

requirements items:
{ "title": str, "description": str, "req_type": "functional"|"non-functional", "priority": "high"|"medium"|"low", "confidence": 0.0-1.0, "source_quote": str (<=150 chars verbatim) }

stakeholders items:
{ "name": str (full name), "role": str, "organization": str, "influence": 1-5, "interest": 1-5, "confidence": 0.0-1.0, "source_quote": str }
RULE: stakeholders = PEOPLE, HUMAN ROLES, ORGANISATIONS only (never software/systems)

processes items:
{ "name": str, "description": str, "steps": [{"order":int,"action":str,"actor":str}], "mermaid_syntax": "flowchart TD\\n...", "confidence": 0.0-1.0, "source_quote": str }

decisions items:
{ "title": str, "description": str, "rationale": str, "decision_maker": str, "status": "proposed"|"approved"|"deferred"|"rejected", "confidence": 0.0-1.0, "source_quote": str }

risks items:
{ "title": str, "description": str, "category": "technical"|"business"|"resource"|"schedule"|"regulatory", "likelihood": 1-5, "impact": 1-5, "mitigation": str, "owner": str, "confidence": 0.0-1.0, "source_quote": str }

business_rules items:
{ "title": str, "description": str, "category": "validation"|"calculation"|"authorization"|"constraint"|"other", "confidence": 0.0-1.0, "source_quote": str }

systems items:
{ "name": str, "system_type": "existing"|"proposed"|"external", "description": str, "integrations": [str], "confidence": 0.0-1.0, "source_quote": str }
RULE: systems = SOFTWARE, DATABASES, PLATFORMS, TOOLS, IT INFRASTRUCTURE only (never people)

kpis items:
{ "name": str, "description": str, "target_value": str, "measurement_method": str, "frequency": "daily"|"weekly"|"monthly"|"quarterly"|"yearly", "owner": str, "confidence": 0.0-1.0, "source_quote": str }

IMPORTANT:
- confidence must be a float between 0.0 and 1.0
- source_quote must be verbatim text from the source, max 150 characters
- Return ONLY the JSON object, no markdown fences`;

const CHUNK_SIZE = 6000;

/**
 * Call Claude with optional prompt caching on the system prompt.
 */
async function callClaude(messages, systemPrompt, maxTokens = 4096) {
  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages,
  });
  return response;
}

/**
 * Extract entities from one text chunk. Returns parsed entity arrays.
 */
async function extractChunk(text) {
  let attempts = 0;
  let currentText = text;

  while (attempts < 3) {
    attempts++;
    let response;
    try {
      response = await callClaude(
        [{ role: 'user', content: `Extract all entities from the following text:\n\n${currentText}` }],
        EXTRACTION_SYSTEM_PROMPT,
        4096
      );
    } catch (err) {
      if (attempts >= 3) throw err;
      continue;
    }

    const raw = response.content[0].text.trim();

    // If model hit max_tokens, split chunk in half and retry (max 1 recursion)
    if (response.stop_reason === 'max_tokens' && currentText.length > 1000) {
      const half = Math.floor(currentText.length / 2);
      const [a, b] = await Promise.all([
        extractChunk(currentText.slice(0, half)),
        extractChunk(currentText.slice(half)),
      ]);
      return mergeEntities(a, b);
    }

    // Strip markdown fences if present
    const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      const parsed = JSON.parse(clean);
      return sanitiseEntities(parsed);
    } catch (_) {
      if (attempts >= 3) return {};
    }
  }
  return {};
}

function mergeEntities(a, b) {
  const keys = ['requirements', 'stakeholders', 'processes', 'decisions',
                 'risks', 'business_rules', 'systems', 'kpis'];
  const out = {};
  for (const k of keys) {
    const arr = [...(a[k] || []), ...(b[k] || [])];
    if (arr.length) out[k] = arr;
  }
  return out;
}

function sanitiseEntities(raw) {
  const out = {};
  const keys = ['requirements', 'stakeholders', 'processes', 'decisions',
                 'risks', 'business_rules', 'systems', 'kpis'];
  for (const k of keys) {
    if (!Array.isArray(raw[k])) continue;
    out[k] = raw[k].map(e => {
      const item = { ...e };
      if (typeof item.confidence === 'number') {
        item.confidence = Math.min(1, Math.max(0, item.confidence));
      } else {
        item.confidence = 0.5;
      }
      if (typeof item.source_quote === 'string' && item.source_quote.length > 150) {
        item.source_quote = item.source_quote.slice(0, 150);
      }
      return item;
    });
  }
  return out;
}

/**
 * Chunked extraction pipeline. Calls extractChunk for each 6000-char chunk.
 * Returns { entities: {...}, chunksTotal: n, usage: { input, output } }
 */
async function extractAllChunks(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }

  let merged = {};
  let totalInput = 0, totalOutput = 0;

  for (const chunk of chunks) {
    const result = await extractChunk(chunk);
    merged = mergeEntities(merged, result);
  }

  return { entities: merged, chunksTotal: chunks.length };
}

/**
 * Generate a structured JSON insight (future state, roadmap, etc.)
 */
async function callClaudeStructured(systemPrompt, userPrompt, maxTokens = 6000) {
  const response = await callClaude(
    [{ role: 'user', content: userPrompt }],
    systemPrompt,
    maxTokens
  );
  const raw   = response.content[0].text.trim();
  const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(clean);
}

/**
 * Log token usage to UsageStats and RateEvents.
 */
async function logUsage(projectId, userId, inputTokens, outputTokens, action = 'extract') {
  try {
    const pool  = await getPool();
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const keys  = [month, `${month}|proj|${projectId}`];

    for (const k of keys) {
      await pool.request()
        .input('k', sql.NVarChar, k)
        .input('i', sql.Int, inputTokens)
        .input('o', sql.Int, outputTokens)
        .query(`
          IF EXISTS (SELECT 1 FROM dbo.UsageStats WHERE stat_key = @k)
            UPDATE dbo.UsageStats
            SET input_tokens  = input_tokens  + @i,
                output_tokens = output_tokens + @o,
                calls         = calls + 1,
                updated_at    = GETUTCDATE()
            WHERE stat_key = @k
          ELSE
            INSERT INTO dbo.UsageStats (stat_key, input_tokens, output_tokens, calls)
            VALUES (@k, @i, @o, 1)
        `);
    }

    await pool.request()
      .input('uid', sql.UniqueIdentifier, userId)
      .input('pid', sql.UniqueIdentifier, projectId)
      .input('act', sql.NVarChar,         action)
      .query('INSERT INTO dbo.RateEvents (user_id, project_id, action) VALUES (@uid, @pid, @act)');
  } catch (err) {
    console.error('[ai.logUsage]', err);
  }
}

/**
 * Sliding-window rate limit check. Returns true if limited.
 */
async function isRateLimited(userId, projectId, action) {
  try {
    const settings = await getAiSettings();
    if (!settings.rate_limit_enabled) return false;

    const pool      = await getPool();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const userKey  = action === 'insight' ? 'max_insight_per_user_per_hour' : 'max_extract_per_user_per_hour';
    const projKey  = action === 'insight' ? 'max_insight_per_project_per_hour' : 'max_extract_per_project_per_hour';

    const userCount = await pool.request()
      .input('uid', sql.UniqueIdentifier, userId)
      .input('act', sql.NVarChar, action)
      .input('ts',  sql.DateTime2, oneHourAgo)
      .query('SELECT COUNT(*) AS cnt FROM dbo.RateEvents WHERE user_id=@uid AND action=@act AND called_at>=@ts');

    if (userCount.recordset[0].cnt >= settings[userKey]) return true;

    const projCount = await pool.request()
      .input('pid', sql.UniqueIdentifier, projectId)
      .input('act', sql.NVarChar, action)
      .input('ts',  sql.DateTime2, oneHourAgo)
      .query('SELECT COUNT(*) AS cnt FROM dbo.RateEvents WHERE project_id=@pid AND action=@act AND called_at>=@ts');

    return projCount.recordset[0].cnt >= settings[projKey];
  } catch (_) {
    return false;
  }
}

/**
 * Read AI limit settings from AppSettings.
 */
async function getAiSettings() {
  try {
    const pool   = await getPool();
    const result = await pool.request()
      .input('k', sql.NVarChar, 'ai_limits')
      .query('SELECT setting_value FROM dbo.AppSettings WHERE setting_key = @k');
    if (result.recordset.length) return JSON.parse(result.recordset[0].setting_value);
  } catch (_) {}
  return {
    rate_limit_enabled: false,
    max_insight_per_user_per_hour: 10,
    max_extract_per_user_per_hour: 20,
    max_insight_per_project_per_hour: 20,
    max_extract_per_project_per_hour: 40,
    budget_enabled: false,
    max_monthly_tokens: 1000000,
  };
}

/**
 * Summarise entities for use in insight prompts.
 */
async function summariseEntities(projectId) {
  const pool    = await getPool();
  const pid     = { type: sql.UniqueIdentifier, value: projectId };
  const tables  = ['Requirements', 'Stakeholders', 'Processes', 'Decisions', 'Risks', 'BusinessRules', 'Systems', 'KPIs'];
  const summary = {};

  for (const t of tables) {
    const r = await pool.request()
      .input('pid', sql.UniqueIdentifier, projectId)
      .query(`SELECT TOP 30 * FROM dbo.${t} WHERE project_id = @pid ORDER BY created_at DESC`);
    summary[t.toLowerCase()] = r.recordset;
  }
  return summary;
}

module.exports = {
  callClaude,
  extractAllChunks,
  callClaudeStructured,
  logUsage,
  isRateLimited,
  getAiSettings,
  summariseEntities,
};
