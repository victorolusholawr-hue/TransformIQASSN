# TransformIQ Association — Claude Code Guide

## Project Overview

An AI-powered business transformation platform for the Association brand. Analysts upload meeting transcripts, documents, and other sources; Claude extracts 8 entity types; the platform builds a knowledge graph, generates visualizations, produces AI insights (future state, roadmap, user stories, etc.), and exports professional deliverables (BRD, FRD, Risk Register, Executive Summary).

Port of the original TransformIQ Python/Flask/MongoDB app into Node.js/Express/EJS/MSSQL.

## Tech Stack

- **Backend:** Node.js 20, Express 4.19, EJS 3.1 via `express-ejs-layouts`
- **Database:** SQL Server 2022 (Docker); `mssql` npm package (Tedious driver); **all queries parameterised** — `request.input(name, type, value)`
- **Auth:** `bcryptjs` local login; sessions via `express-session`; CSRF via custom `middleware/csrf.js`
- **AI:** `@anthropic-ai/sdk`; model configurable via `ANTHROPIC_MODEL` env var (default `claude-opus-4-7`); prompt caching on system messages
- **File parsing:** `pdf-parse`, `mammoth` (docx), `xlsx`, `tesseract.js` (images/OCR)
- **Export generation:** `docx` (Word), `exceljs` (Excel), `puppeteer` (PDF)
- **File storage:** Azure Blob Storage (production); local `public/uploads/` (dev, when `AZURE_STORAGE_CONNECTION_STRING` is blank)
- **Styling:** Single CSS file (`public/css/style.css`), CSS variables, no preprocessor
- **Deployment:** Docker Compose (`app` port 8082→3000, `db` SQL Server port 1434→1433)

## Running the App

### With Docker (recommended)

```bash
cp .env.example .env       # fill in SESSION_SECRET, DB_PASSWORD, ANTHROPIC_API_KEY
docker compose up --build
```

App runs at **http://localhost:8082**. SQL Server on port 1434.

The `db/init.js` bootstrap runs on every start — it connects to `master` first to `CREATE DATABASE IF NOT EXISTS`, then connects to the app DB and runs `db/schema.sql` (all statements are idempotent).

### Locally (requires SQL Server on localhost:1433)

```bash
cp .env.example .env   # set DB_SERVER=localhost
npm install
node app.js
```

## Project Structure

```
TransformIQ_Association/
├── app.js                    # Express entry point — middleware, routes, error handler
├── package.json
├── Dockerfile                # Node 20-slim + tesseract-ocr
├── docker-compose.yml        # app (8082→3000) + db SQL Server 2022 (1434→1433)
├── .env.example              # env var template
├── .gitignore                # node_modules, .env, public/uploads/
├── config/
│   ├── database.js           # getPool() singleton + getMasterPool() for bootstrap
│   └── storage.js            # saveUpload(), saveBuffer(), deleteUpload() — Azure or local
├── db/
│   ├── schema.sql            # 20 tables, all IF NOT EXISTS; includes idempotent ALTER TABLE migrations for new columns
│   └── init.js               # master-first bootstrap → schema run
├── middleware/
│   ├── auth.js               # loginRequired, analystRequired, adminRequired
│   ├── csrf.js               # token generation + POST validation
│   └── projectAccess.js      # queries ProjectMembers, attaches req.project + req.projectMember
├── routes/
│   ├── auth.js               # /login /register /logout
│   ├── dashboard.js          # /dashboard
│   ├── admin.js              # /admin/usage
│   ├── projects.js           # /projects /projects/create /projects/:id ...
│   ├── sources.js            # /projects/:id/sources /sources/:id ...
│   ├── entities.js           # all 8 entity types
│   ├── graph.js              # /projects/:id/graph /traceability
│   ├── visualize.js          # /visualize/process-map /raci /stakeholder-map /gap-analysis /risk-heatmap
│   ├── insights.js           # /future-state /roadmap /user-stories /acceptance-criteria /impact-matrix /voice-capture
│   └── export.js             # /export + 5 export POST routes
├── services/
│   ├── ai.js                 # callClaude(), extractChunk(), callClaudeStructured(), logUsage(), isRateLimited(); exports CHUNK_SIZE, MAX_CHUNKS, MAX_TEXT_CHARS, assertAiConfigured
│   ├── fileParser.js         # parseFile() — PDF/DOCX/XLSX/TXT/image → { text, metadata }; Claude Vision fallback for images
│   ├── graphBuilder.js       # buildGraphEdges() — infers relationships, inserts into GraphEdges
│   ├── exportBuilder.js      # buildBrd(), buildFrd(), buildRiskRegister(), buildExecutiveSummary(), buildExecutiveSummaryPdf(), buildFutureState()
│   ├── mssqlSessionStore.js  # Custom express-session store backed by dbo.Sessions; get/set/destroy/touch/prune methods
│   └── sourceStatus.js       # reconcileProjectSourceStatuses(), reconcileSingleSourceStatus() — fixes stuck ai_status by checking actual entity counts
├── public/
│   ├── favicon.svg           # SVG favicon — white "T" on rounded #72246c square; linked in layout.ejs
│   ├── css/style.css         # All styles — CSS variables, Association purple #72246c
│   └── uploads/              # Local dev file storage (gitignored)
│       ├── sources/
│       └── exports/
└── views/
    ├── layout.ejs            # Navbar, flash, dark mode toggle, page-body wrapper
    ├── error.ejs             # 404/500 error page
    ├── partials/
    │   ├── navbar.ejs        # Brand nav, theme toggle (event-listener, no inline onclick), user info
    │   ├── flash.ejs         # Flash message partials
    │   ├── insights_nav.ejs  # Tab bar shared by all insights pages
    │   └── insights_toast.ejs # AI generation toast (spinner/success/error); included on every insight page
    ├── auth/                 # login.ejs, register.ejs
    ├── dashboard/            # home.ejs — pipeline hero + project cards
    ├── admin/                # usage.ejs — token stats + rate limit settings
    ├── projects/             # create.ejs, detail.ejs (sidebar layout), edit.ejs
    ├── sources/              # list.ejs, upload.ejs, detail.ejs
    ├── entities/             # Each entity type has a dedicated custom list view (no longer shared _list.ejs):
    │                         # requirements.ejs, stakeholders.ejs (with duplicate review panel + merge modal),
    │                         # processes.ejs, decisions.ejs, risks.ejs, business_rules.ejs,
    │                         # systems.ejs, kpis.ejs, detail.ejs, requirement_detail.ejs (two-column with sidebar)
    ├── graph/                # view.ejs (Cytoscape.js), traceability.ejs
    ├── visualize/            # process_map.ejs, raci.ejs, stakeholder_map.ejs,
    │                         # gap_analysis.ejs, risk_heatmap.ejs
    ├── insights/             # future_state.ejs, roadmap.ejs, user_stories.ejs,
    │                         # acceptance_criteria.ejs, impact_matrix.ejs, voice_capture.ejs
    │                         # All insight pages include insights_toast.ejs and submit generate
    │                         # forms via AJAX (window.tiqFetchJson) — no full-page reload on generate
    └── export/               # index.ejs, executive_summary_pdf.ejs
```

## SQL Server Tables

| Table | Key columns |
|---|---|
| `dbo.Users` | `id` (UNIQUEIDENTIFIER PK), `name`, `email` UNIQUE, `password_hash`, `role` (analyst\|viewer\|admin) |
| `dbo.Projects` | `id`, `name`, `description`, `owner_id` FK→Users, `status` (active\|archived), `tags` JSON |
| `dbo.ProjectMembers` | `id`, `project_id`, `user_id`, `role` (owner\|analyst\|viewer), UNIQUE(project_id, user_id) |
| `dbo.Sources` | `id`, `project_id`, `name`, `source_type`, `file_url`, `file_ext`, `extracted_text`, `extraction_status`, `ai_status`, `chunks_total`, `participants` JSON, `metadata` JSON |
| `dbo.Requirements` | `id`, `project_id`, `source_id`, `req_type`, `title`, `description`, `priority`, `status` (pending\|confirmed\|rejected), `confidence`, `source_quote`, `duplicate_candidates` JSON, `needs_review` BIT |
| `dbo.Processes` | `id`, `project_id`, `source_id`, `name`, `description`, `steps` JSON, `mermaid_syntax`, `confidence`, `source_quote` |
| `dbo.Stakeholders` | `id`, `project_id`, `source_id`, `name`, `role`, `organization`, `influence` INT, `interest` INT, `confidence`, `source_quote`, `duplicate_candidates` JSON, `needs_review` BIT |
| `dbo.Decisions` | `id`, `project_id`, `source_id`, `title`, `description`, `rationale`, `decision_maker`, `status`, `confidence`, `source_quote` |
| `dbo.Risks` | `id`, `project_id`, `source_id`, `title`, `description`, `category`, `likelihood` INT, `impact` INT, `mitigation`, `owner`, `confidence`, `source_quote` |
| `dbo.BusinessRules` | `id`, `project_id`, `source_id`, `title`, `description`, `category`, `confidence`, `source_quote` |
| `dbo.Systems` | `id`, `project_id`, `source_id`, `name`, `system_type`, `description`, `integrations` JSON, `confidence`, `source_quote` |
| `dbo.KPIs` | `id`, `project_id`, `source_id`, `name`, `description`, `target_value`, `measurement_method`, `frequency`, `owner`, `confidence`, `source_quote` |
| `dbo.GraphEdges` | `id`, `project_id`, `source_node_id`, `source_node_type`, `target_node_id`, `target_node_type`, `relationship`, `weight` |
| `dbo.Documents` | `id`, `project_id`, `doc_type`, `file_url`, `generated_by`, `generated_at`, `version` |
| `dbo.AIInsights` | `id`, `project_id`, `type`, `content` JSON, `generated_by`, `generated_at`, UNIQUE(project_id, type) |
| `dbo.RoadmapTasks` | `id`, `project_id`, `phase_name`, `req_title`, `status`, `owner`, `due_date`, `notes`, `sort_order`, UNIQUE(project_id, phase_name, req_title) |
| `dbo.UsageStats` | `stat_key` PK, `input_tokens`, `output_tokens`, `calls`, `updated_at` |
| `dbo.RateEvents` | `id`, `user_id`, `project_id`, `action`, `called_at` |
| `dbo.AppSettings` | `setting_key` PK, `setting_value` |
| `dbo.Sessions` | `sid` (NVARCHAR(255) PK), `sess` (NVARCHAR(MAX) JSON), `expires_at` DATETIME2, `updated_at` DATETIME2; indexed on `expires_at` |

JSON fields (`tags`, `steps`, `integrations`, `participants`, `metadata`, `content`, etc.) stored as `NVARCHAR(MAX)` — parsed with `JSON.parse()` and written with `JSON.stringify()` in the JS layer. Never pass raw JSON strings directly; always parse before use.

## Auth Pattern

Three middleware functions in `middleware/auth.js`:

```javascript
loginRequired(req, res, next)   // checks session.userId AND verifies user still exists in DB
analystRequired(req, res, next) // wraps loginRequired; blocks role='viewer'
adminRequired(req, res, next)   // blocks role!='admin'
```

`loginRequired` always does a live DB check (`SELECT id FROM dbo.Users WHERE id = @id`) to guard against stale sessions after DB resets or account deletion. On failure, it redirects to `loginPath(req)` — which constructs `/login?next=<originalUrl>` so the user returns to their intended page after signing in.

`loginPath(req)` in `middleware/auth.js` — builds the login redirect URL, preserving the current path as `?next=`.

`safeNextPath(next)` in `routes/auth.js` — validates the `next` param on login: rejects empty strings, non-root paths, double-slashes, and backslash URLs (open-redirect prevention); defaults to `/dashboard`.

Session keys: `userId` (string/UUID), `role`, `name`.

`projectAccessRequired` in `middleware/projectAccess.js` queries `dbo.ProjectMembers` for `(project_id, user_id)`, attaches `req.project` and `req.projectMember`, returns 404 if not a member.

CSRF: every POST/PUT/DELETE request must include `_csrf` matching `req.session.csrfToken`. All EJS forms include `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`. Token available in templates via `res.locals.csrfToken`. `tiqFetchJson` always sets the `X-CSRF-Token` request header for all non-GET requests (regardless of body type), so FormData AJAX requests are not rejected by CSRF middleware.

## URL Routes

### Auth
| Method | Path | Description |
|---|---|---|
| GET/POST | `/login` | bcryptjs verify → set session |
| GET/POST | `/register` | bcryptjs hash → insert user |
| GET | `/logout` | destroy session |
| GET | `/` | redirect to /dashboard or /login |

### Dashboard
| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Pipeline hero + project cards (owner + member) |

### Admin
| Method | Path | Description |
|---|---|---|
| GET | `/admin/usage` | Token stats, rate limit settings |
| POST | `/admin/usage` | Update rate limit settings in AppSettings |

### Projects
| Method | Path | Description |
|---|---|---|
| GET | `/projects` | List all accessible projects |
| GET/POST | `/projects/create` | Create project |
| GET | `/projects/:id` | Project detail — sidebar + entity grid + members |
| GET/POST | `/projects/:id/edit` | Edit project name/description/tags |
| POST | `/projects/:id/delete` | Delete project + cascade all data |
| POST | `/projects/:id/archive` | Set status=archived |
| POST | `/projects/:id/restore` | Set status=active |
| POST | `/projects/:id/members/invite` | Add member by email |
| POST | `/projects/:id/members/:uid/remove` | Remove member (owner only) |

### Sources
| Method | Path | Description |
|---|---|---|
| GET | `/projects/:id/sources` | List all sources for project |
| GET/POST | `/projects/:id/sources/upload` | Upload new source (multer) |
| GET | `/sources/:id` | Source detail — extracted text, entity counts |
| POST | `/sources/:id/extract` | Run file parsing + AI extraction (chunked) |
| POST | `/sources/:id/delete` | Delete source + file |
| GET | `/projects/:id/sources/done-ids` | JSON API: list of source IDs with ai_status=done |

### Entities (all 8 types)
Entity type URL slugs: `requirements`, `stakeholders`, `processes`, `decisions`, `risks`, `business_rules`, `systems`, `kpis`

| Method | Path | Description |
|---|---|---|
| GET | `/projects/:id/:type` | List entities with filters (?priority=, ?status=, ?confidence_min=) |
| GET | `/projects/:id/:type/:eid` | Entity detail |
| POST | `/projects/:id/:type/:eid/edit` | Update entity fields |
| POST | `/projects/:id/:type/:eid/delete` | Delete entity |
| POST | `/projects/:id/requirements/:eid/confirm` | Set requirement status=confirmed |
| POST | `/projects/:id/requirements/:eid/reject` | Set requirement status=rejected |
| POST | `/projects/:id/requirements/bulk-action` | Bulk confirm/reject/delete |
| POST | `/projects/:id/stakeholders/:eid/merge` | Merge duplicate stakeholders |
| POST | `/api/entities/:type/:id/update` | JSON AJAX update |

### Graph
| Method | Path | Description |
|---|---|---|
| GET | `/projects/:id/graph` | Cytoscape.js knowledge graph viewer |
| GET | `/projects/:id/graph/data` | JSON API — Cytoscape elements format |
| GET | `/projects/:id/traceability` | Traceability matrix (HTML table) |

### Visualize
| Method | Path | Description |
|---|---|---|
| GET | `/projects/:id/visualize/process-map` | Mermaid.js process flow diagrams |
| GET | `/projects/:id/visualize/raci` | RACI matrix |
| POST | `/projects/:id/visualize/raci/update-cell` | AJAX update single RACI cell |
| GET | `/projects/:id/visualize/stakeholder-map` | Influence/Interest scatter plot |
| GET | `/projects/:id/visualize/gap-analysis` | AI-generated gap analysis |
| GET | `/projects/:id/visualize/risk-heatmap` | Likelihood × Impact risk heatmap |

### AI Insights
| Method | Path | Description |
|---|---|---|
| GET/POST | `/projects/:id/future-state` | AI future state narrative |
| GET/POST | `/projects/:id/roadmap` | Phased roadmap with tasks |
| POST | `/projects/:id/roadmap/update-task` | AJAX update roadmap task |
| POST | `/projects/:id/roadmap/delete-task` | AJAX delete roadmap task |
| POST | `/projects/:id/roadmap/reorder-task` | AJAX reorder roadmap task |
| GET/POST | `/projects/:id/user-stories` | AI-generated user stories |
| GET/POST | `/projects/:id/acceptance-criteria` | Acceptance criteria per requirement |
| GET/POST | `/projects/:id/impact-matrix` | Stakeholder × requirement impact matrix |
| GET | `/projects/:id/voice-capture` | Voice capture transcript viewer |
| POST | `/projects/:id/voice-capture/save` | Save voice capture notes |

### Export
| Method | Path | Description |
|---|---|---|
| GET | `/projects/:id/export` | Export hub — available documents |
| POST | `/projects/:id/export/brd` | Generate + download BRD (Word .docx) |
| POST | `/projects/:id/export/frd` | Generate + download FRD (Word .docx) |
| POST | `/projects/:id/export/risk-register` | Generate + download Risk Register (Excel .xlsx) |
| POST | `/projects/:id/export/executive-summary` | Generate Executive Summary — `format=docx` (Word) or `format=pdf` (Puppeteer PDF, default) |
| POST | `/projects/:id/export/future-state` | Generate + download Future State document (Word) |

## AI Service (`services/ai.js`)

- **Model:** configurable via `ANTHROPIC_MODEL` env var (default `claude-opus-4-7`); prompt caching via `cache_control: { type: "ephemeral" }` on system messages
- **`extractChunk(text, projectId, chunkIdx, totalChunks)`** — sends a 6,000-char chunk with the 8-entity extraction system prompt; returns structured JSON of all entities found
- **`callClaudeStructured(systemPrompt, userPrompt, maxTokens)`** — for insight generation (future state, roadmap, etc.)
- **`logUsage(projectId, userId, inputTokens, outputTokens)`** — writes to `dbo.UsageStats` (UPSERT) and `dbo.RateEvents`
- **`isRateLimited(userId, projectId, action)`** — 60-minute sliding window; limits from `dbo.AppSettings`
- The extraction system prompt is stored as a constant in `services/ai.js` — same prompt as original TransformIQ

## File Storage Pattern

`config/storage.js` exports three helpers:
- **`saveUpload(multerFile, folder)`** — if `AZURE_STORAGE_CONNECTION_STRING` set: uploads to Azure Blob, deletes temp, returns blob URL. Otherwise returns `/uploads/<folder>/<filename>`.
- **`saveBuffer(buffer, filename, folder)`** — for generated exports (docx, xlsx, PDF)
- **`deleteUpload(url)`** — removes local file or Azure blob

Multer is configured per-route in `routes/sources.js` — `dest: 'public/uploads/sources/'`.

## CSS Conventions

All styles in `public/css/style.css`. Key design tokens:

```css
:root {
  --primary:      #72246c;   /* Association brand purple */
  --primary-dark: #5a1c55;
  --grad-purple:  linear-gradient(to top right, #672D89 20%, #72246c 70%, #c2188b 100%);
  --success:      #48a23f;
  --warning:      #f0b323;
  --danger:       #dc6b2f;
  --info:         #41b6e6;
  --teal:         #0D9488;
  --pink:         #c2188b;
  --bg:           #f5f4f7;
  --surface:      #ffffff;
  --border:       #e2dde8;
  --text:         #1a1523;
  --muted:        #7a6e85;
  --sidebar-width: 260px;
}
```

Dark mode via `[data-theme="dark"]` on `<html>`. Theme applied by inline script in `<head>` (reads `localStorage.getItem('theme')` before body renders to prevent flash). Toggled by `.theme-btn` in navbar — must have `type="button"` to avoid form submission.

**Body background:** uses `background-color: var(--bg)` and `background-image` as separate properties — do NOT use the `background` shorthand followed by `background-image` in the same rule block (causes Chromium paint invalidation when CSS vars change on theme toggle).

**Hamburger menu:** `this.parentElement.classList.toggle('open')` adds `open` to `.navbar`. The CSS rule must be `.navbar.open .navbar-links { display: flex }` — not `.navbar-links.open`.

**Project detail layout:**
- `.project-layout` — `display: flex; align-items: flex-start` (flex-start required for sticky sidebar)
- `.project-sidebar` — `position: sticky; top: 60px; width: 260px; max-height: calc(100vh - 60px); overflow-y: auto`
- `.project-main` — `flex: 1; min-width: 0; padding: 24px`
- `.sidebar-link` / `.sidebar-link-icon` / `.sidebar-badge` / `.sidebar-section-label` / `.sidebar-divider` — sidebar nav elements

**Entity icon colours (applied to `.sidebar-link-icon` and `.entity-card-icon`):**
```css
.ec-requirements  { background: #72246c; }
.ec-stakeholders  { background: #c2188b; }
.ec-processes     { background: #41b6e6; }
.ec-decisions     { background: #0D9488; }
.ec-risks         { background: #dc6b2f; }
.ec-business-rules{ background: #f0b323; color: #1a1523 !important; }
.ec-systems       { background: #48a23f; }
.ec-kpis          { background: #672D89; }
```

**Key component classes:**
- `.btn-primary` / `.btn-outline` / `.btn-danger` / `.btn-sm` — button variants
- `.badge-success` / `.badge-warning` / `.badge-danger` / `.badge-muted` / `.badge-role` — status pills
- `.card` / `.entity-card` / `.entity-grid` — content cards
- `.form-group` / `.form-label` / `.form-input` / `.form-actions` — form building blocks
- `.section` / `.section-header` — bordered content blocks
- `.page-header` / `.header-actions` / `.page-sub` — page title area with optional subtitle link
- `.projects-grid` — auto-fill card grid for project list
- `.project-card` / `.project-card-header` / `.project-card-name` / `.project-card-desc` / `.project-card-meta` / `.project-card-actions` — dashboard project cards (actions row: Open + Upload Source buttons)
- `.pipeline-hero` / `.pipeline-steps` / `.pipeline-step` / `.step-num` / `.step-label` / `.pipeline-arrow` — dashboard hero
- `.members-list` / `.member-item` / `.member-avatar` / `.member-info` / `.member-name` / `.member-email` — team member rows
- `.students-table` — data tables (reused from LMS)
- `.empty-state` — centered empty content placeholder
- `.flash` / `.flash-success` / `.flash-error` / `.flash-warning` — flash messages
- `.pill` / `.confidence-pill` — inline status chips on entity lists

**Insights component classes:**
- `.insight-section` — bordered section card on insight detail pages
- `.insight-grid` — responsive auto-fill grid for insight cards
- `.insight-card` — individual insight item card (key transformation, scenario, etc.)
- `.insight-narrative` — full-width paragraph block for narrative/overview text
- `.insight-list` — styled `<ul>` for bullet items in insight sections
- `.insight-value-tag` — small tinted pill for business value labels
- `.insight-generated-at` — muted timestamp line below page header
- `.insight-generate-form` — class required on every generate `<form>` for the toast AJAX handler to pick it up

**Roadmap component classes:**
- `.roadmap-summary-bar` — overall progress bar row above phases
- `.roadmap-overall-bar` / `.roadmap-overall-fill` — overall progress track + fill
- `.roadmap-overall-pct` / `.roadmap-total-estimate` — counter and total duration labels
- `.roadmap-rationale` — phasing rationale text block
- `.roadmap-phases` — container for all phase cards
- `.roadmap-phase` — individual phase card
- `.roadmap-phase-header` — flex row: phase number chip + name + duration
- `.roadmap-phase-num` — circle chip; colour variants `.phase-color-0` through `.phase-color-3`
- `.roadmap-phase-name` / `.roadmap-phase-duration` — phase identity text
- `.roadmap-phase-body` — content area: objective, progress, task list
- `.roadmap-phase-progress-wrap` / `.roadmap-phase-progress-bar` / `.roadmap-phase-progress-fill` — per-phase progress
- `.roadmap-task-list` / `.roadmap-task-item` — task rows within a phase
- `.roadmap-task-title` / `.roadmap-task-controls` — task item internals

**AI Toast component classes (in `insights_toast.ejs`):**
- `.ai-toast` — fixed-position toast container; hidden by default
- `.ai-toast-visible` — makes toast visible (added/removed by JS)
- `.ai-toast-analyzing` / `.ai-toast-success` / `.ai-toast-error` — state variants
- `.ai-toast-icon` / `.ai-toast-spinner` / `.ai-toast-body` / `.ai-toast-close` — internals

**Voice capture component classes:**
- `.voice-page` — wrapper for the voice capture page
- `.voice-browser-warn` — browser-incompatibility warning banner
- `.voice-speaker-panel` — card containing speaker management UI
- `.voice-speaker-header` / `.voice-speaker-form` — speaker panel internals
- `.speaker-chip-row` — flex row of speaker chips
- `.speaker-chip` / `.speaker-chip.active` — individual speaker selection chips
- `.voice-controls` / `.rec-btn` / `.rec-btn-start` / `.rec-btn-pause` / `.rec-btn-stop` — recording controls
- `.rec-meta` / `.speaker-label` — meta row below recording buttons

**Entity list / detail classes:**
- `.entity-filter-bar` — flex filter row (confidence slider, status dropdown) above entity tables
- `.entity-section-body` — content area within entity detail sections
- `.entity-edit-card` — card wrapper for inline edit form
- `.entity-detail-list` / `.entity-detail-label` — definition list rows in entity detail sidebar
- `.entity-source-quote` — styled blockquote for verbatim source text on detail pages
- `.entity-table-quote` — truncated source quote cell inside entity tables
- `.confidence-badge-high` / `.confidence-badge-med` / `.confidence-badge-low` — colour-coded confidence pills
- `.btn-warning` — amber warning button variant
- `.inline-actions` — flex row of compact action buttons

**Stakeholder duplicate review classes:**
- `.stakeholder-filter-bar` — filter row specific to stakeholder list
- `.duplicate-review-panel` / `.duplicate-review-header` / `.duplicate-review-row` — review panel container and rows
- `.duplicate-review-candidates` / `.duplicate-chip` — candidate chip list within each duplicate row
- `.modal-backdrop` / `.modal-panel` — full-screen modal overlay and centered panel

**Sources table classes:**
- `.sources-table` — full-width table for sources list
- `.table-method` / `.table-actions` / `.table-help` / `.table-error` — table cell utility classes
- `.upload-success-bar` / `.upload-success-icon` / `.upload-success-link` — compact success notification bar on upload page

**Visualize page classes:**
- `.risk-heatmap-wrap` / `.heatmap-matrix` / `.heatmap-axis` / `.heatmap-header-row` / `.heatmap-row` / `.heatmap-row-label` — risk heatmap layout
- `.heatmap-cell` / `.heatmap-cell-empty` / `.heatmap-cell-low` / `.heatmap-cell-med` / `.heatmap-cell-high` / `.heatmap-cell-critical` — heatmap cell colour zones
- `.heatmap-cell-count` / `.heatmap-cell-label` / `.heatmap-detail` / `.heatmap-high-badge` — heatmap cell internals
- `.raci-sticky` — sticky first column/header in RACI table; `.raci-cell` — clickable cell; `.raci-readonly` — read-only state; `.raci-R` / `.raci-A` / `.raci-C` / `.raci-I` / `.raci-S` — RACI assignment colour variants
- `.mermaid-container` — scrollable wrapper for Mermaid diagrams; `.process-steps` — ordered step list; `.source-quote` — verbatim quote block on process map
- `.stakeholder-map-layout` / `.stakeholder-chart-container` / `.stakeholder-side-list` / `.stakeholder-side-row` — two-column stakeholder map layout
- `.quadrant-grid` — 2×2 strategic quadrant reference grid below stakeholder chart
- `.gap-list` / `.gap-item` / `.gap-header` / `.gap-row` / `.gap-label` / `.gap-issue` / `.gap-recommendation` / `.reco-list` — gap analysis layout
- `.requirement-detail-grid` — two-column CSS grid for requirement detail page

**Export hub classes:**
- `.export-grid` — auto-fit card grid (min 240px columns, 18px gap)
- `.export-card` — flex-column card with surface bg, border, shadow; full-width buttons
- `.export-icon` — 2rem emoji icon at top of each card
- `.export-format-actions` — 2-column grid for docx/pdf button pair on Executive Summary card
- `.export-card-disabled` — 0.72 opacity for cards with no available data (e.g. Future State before generation)
- `.export-history-section` / `.export-history-icon` — history table section and doc-type emoji icon

**Responsive breakpoints:**
- `≤768px` — hamburger nav, stacked layout
- `≤640px` — single column, full-width buttons, 44px touch targets

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | No | `development` / `production` (affects cookie.secure, TLS cert trust) |
| `PORT` | No | App port inside container (default 3000) |
| `SESSION_SECRET` | Yes | Express session signing key (min 32 chars) |
| `DB_SERVER` | Yes | SQL Server hostname (`db` in Docker) |
| `DB_PORT` | No | SQL Server port (default 1433) |
| `DB_NAME` | No | Database name (default `transformiq_assn`) |
| `DB_USER` | Yes | SQL Server user (default `sa`) |
| `DB_PASSWORD` | Yes | SQL Server password |
| `ANTHROPIC_API_KEY` | For AI features | Claude API key (`sk-ant-...`) |
| `ANTHROPIC_MODEL` | No | Claude model ID (default `claude-opus-4-7`) |
| `AI_CHUNK_SIZE` | No | Characters per extraction chunk (default 6000, min 1000) |
| `AI_MAX_CHUNKS` | No | Max chunks per source (default 25); `MAX_TEXT_CHARS = CHUNK_SIZE × MAX_CHUNKS` |
| `SESSION_STORE` | No | Set to `memory` to use in-memory sessions instead of MSSQL (useful in tests) |
| `AZURE_STORAGE_CONNECTION_STRING` | Production only | Leave blank to use local disk |
| `AZURE_STORAGE_CONTAINER` | Production only | Blob container name |

## Features

### Entity Extraction Pipeline
1. Analyst uploads source file (PDF, DOCX, XLSX, TXT, image)
2. `fileParser.js` extracts plain text + metadata; images first try Tesseract OCR, then fall back to **Claude Vision** (`parseImageWithVision()`) for richer extraction of diagrams, org charts, and tables
3. Text is chunked into `AI_CHUNK_SIZE`-char pieces (default 6,000); capped at `AI_MAX_CHUNKS` total (default 25)
4. Each chunk sent to Claude via `extractChunk()` with the 8-entity system prompt; up to 2 retries per failed chunk with exponential backoff
5. JSON responses parsed with `extractJsonObject()` + `parseJsonLenient()` (handles markdown fences and unescaped control chars)
6. Old entities for the source are cleared before each extraction run; new entities inserted with stakeholder duplicate candidates computed at insert time
7. `graphBuilder.buildGraphEdges()` infers relationships between entities → inserts into `GraphEdges`; graph is also rebuilt after entity edits/deletes

### MSSQL Session Store
- Sessions are persisted in `dbo.Sessions` via `services/mssqlSessionStore.js` — a custom `express-session` compatible store
- Sessions survive container restarts and support horizontal scaling
- TTL is 7 days (`sessionMaxAge`); `rolling: true` auto-extends on each request
- Set `SESSION_STORE=memory` to revert to in-memory store (dev/testing only — sessions lost on restart)
- `prune()` deletes expired sessions; called automatically on `set()`

### Post-Login Redirect
- `loginRequired` redirects to `/login?next=<originalUrl>` so users return to their intended page after authenticating
- Login form includes a hidden `next` field; `safeNextPath()` validates it before redirect (prevents open-redirect attacks)

### Knowledge Graph
- Cytoscape.js viewer at `/projects/:id/graph`
- JSON data endpoint at `/projects/:id/graph/data` returns elements format with nodes (colour-coded by type) and edges
- Node colours match `.ec-*` brand colours
- Traceability matrix accessible via three route aliases: `/projects/:id/traceability`, `/projects/:id/graph/traceability`, `/projects/:id/graph/matrix`

### Stakeholder Duplicate Detection
- At extraction time, each new stakeholder is compared against existing ones using name similarity (>50% token overlap or substring match)
- Matches stored as `duplicate_candidates` JSON array on the stakeholder; `needs_review` BIT set to 1
- Stakeholder list page shows a **Duplicate Review Panel** above the main table when `needs_review` rows exist
- Each candidate pair has a Merge button that opens a modal to select which record to keep; merge clears `needs_review` on both records
- `POST /projects/:id/stakeholders/:eid/merge` handles the merge: transfers GraphEdge references, deletes the discarded record, triggers graph rebuild

### Entity List Pages
All 8 entity type list pages are now fully custom (no longer use a shared `_list.ejs` template):
- **Risks** — table with calculated risk score badge (critical ≥16, high ≥9, medium ≥4), colour-coded; links to risk heatmap
- **Processes** — table with step count and per-row Map button linking to process-map visualisation
- **Decisions** — table with status filter dropdown and colour-coded status badges
- **Systems** — table with system_type badge and integrations list
- **KPIs** — table with frequency badge and owner column
- **Business Rules** — table with category badge
- All pages include a confidence slider filter and per-row delete

### Requirement Detail Page
- Two-column layout: main content (title, description, edit form) + sidebar (type/priority/status/confidence badges, source quote, confirm/reject/delete actions)
- Breadcrumb navigation back to requirements list
- Smart redirect: confirm/reject from detail page stays on detail; from list page returns to list

### AI Insights
Each insight type is generated by `callClaudeStructured()` with the full entity dataset as context — `hasEntities()` + `entityLines()` helpers in `routes/insights.js` build entity-aware prompts. Results stored in `dbo.AIInsights` with UNIQUE(project_id, type) — regenerating overwrites the previous result. Six insight types: future-state, roadmap, user-stories, acceptance-criteria, impact-matrix, voice-capture.

**Anti-hallucination guardrails:** Both the extraction prompt (`EXTRACTION_SYSTEM_PROMPT` in `services/ai.js`) and the insight generation prompt (`SYSTEM_PROMPT` in `routes/insights.js`) contain a `GROUNDING RULES — MANDATORY` block that instructs the model to:
- Only extract/reference entities explicitly present in the provided source text
- Never fabricate names, values, or details not found in the input
- Require a verbatim `source_quote` for every extracted entity; omit the entity if no quote exists
- Score `confidence < 0.5` for anything requiring interpretation; `≥ 0.8` only for unambiguous facts
- For insights: never introduce entities, stakeholders, or systems not listed in the project input

**Async generation flow:** All insight pages submit the generate form via `window.tiqFetchJson` (AJAX). The `insights_toast.ejs` partial shows a spinner while waiting, then a success/error toast on completion. POST routes must return `{ ok: true }` JSON on success (or `{ ok: false, error: "..." }` on failure) — they no longer redirect on success.

**Future State** includes a rich layout: Vision Overview, Key Transformations, Scenarios with optional Mermaid process diagrams, Benefits, and Risks sections. Supports "Export as Word" (calls `POST /export/future-state` → `buildFutureState()` in `exportBuilder.js`).

**Roadmap** includes per-phase and overall progress bars, owner datalist (populated from stakeholder names), inline task status select, and a phasing rationale block. Task updates go via `POST /roadmap/update-task` AJAX.

**Voice Capture** has a speaker panel (add/select speakers as chips), three coloured recording buttons (green mic, orange pause, red stop), filter profanity checkbox, New Turn button, and session-persistent transcript area.

### Rate Limiting
`isRateLimited(userId, projectId, action)` counts `RateEvents` rows in the last 60 minutes. Limits stored per action in `dbo.AppSettings` (configurable by admins at `/admin/usage`).

### Export Documents
Five export types generated by `services/exportBuilder.js`:
- **BRD / FRD** — Word .docx via `docx` npm
- **Risk Register** — Excel .xlsx via `exceljs`
- **Executive Summary** — dual format: `.docx` (Word) or `.pdf` (Puppeteer); format selected via `format` POST param; PDF includes entity counts table, top 8 high-priority requirements, top 8 risks sorted by likelihood × impact, branded header (#72246c)
- **Future State** — Word .docx; triggered from the Future State insight page via "Export as Word" button

Generated files saved via `config/storage.saveBuffer()` and a record inserted into `dbo.Documents` with an auto-incremented `version` (MAX(version)+1 per project+doc_type).

**Export Hub (`views/export/index.ejs`):** card grid layout (`.export-grid`) with one card per document type; Executive Summary card shows two format buttons (Word / PDF); Future State card disabled (`.export-card-disabled`) when no insight has been generated. Export history table shows version badge, document type icon, and per-row Re-generate button.

### Source Status Reconciliation
`services/sourceStatus.js` fixes sources that are stuck in `processing` or `pending` despite having entities extracted:
- `reconcileSingleSourceStatus(pool, sourceId)` — counts entities across all 8 tables for the source; if count > 0 and `ai_status !== 'done'`, sets `ai_status='done'`, clears `ai_error`, stores `ai_reconciled_at` timestamp in metadata
- `reconcileProjectSourceStatuses(pool, projectId)` — same logic applied to all non-`done` sources in a project
- Called automatically on: project detail load, source list load, source detail load — so stuck sources self-heal on next page view without any manual intervention

### Project Access Control
Three-tier access: `owner` (full control + delete), `analyst` (upload/extract/edit), `viewer` (read-only). `projectAccessRequired` middleware enforces membership on every project route. `analystRequired` blocks viewers from write operations.

### Dark Mode
- Toggle button (`🌙/☀`) in navbar — `type="button"`, `class="theme-btn btn-icon"`, **no inline `onclick`**
- `setTheme(theme)` function defined inside a `DOMContentLoaded` listener in `layout.ejs`; button clicks are wired via `addEventListener` — do NOT add `onclick="toggleTheme()"` to the button markup (that function no longer exists globally)
- Preference persisted to `localStorage`; `aria-label` updated dynamically on toggle
- System `prefers-color-scheme` used as default on first visit
- Applied via `data-theme="dark"` on `<html>` by inline script in `<head>` (before body renders to prevent flash)

## Pre-Commit Sanity Checks

Before any commit:

1. **Node syntax** — `node --check app.js` on every modified `.js` file
2. **EJS syntax** — render each modified view with mock data inside the container to catch unclosed tags
3. **CSRF presence** — all `<form method="POST">` forms must include `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`
4. **No SQL injection** — all DB queries must use `request.input(name, sql.Type, value)` — never string-interpolate user data into SQL
5. **Cross-feature regression** — when modifying shared helpers (`getPool`, `saveUpload`, `loginRequired`), grep all call sites
6. **JSON fields** — always `JSON.parse()` when reading and `JSON.stringify()` when writing NVARCHAR(MAX) JSON columns

After committing and pushing, rebuild and restart the local Docker container:

```bash
docker compose up --build -d
```

## Known Limitations / Future Work

- Okta OIDC SSO not yet wired in (stubs in `.env.example`)
- No email notifications
- `public/uploads/` stored on container filesystem — lost on `docker compose down -v`; use Azure Blob in production
- Puppeteer PDF generation requires Chromium inside the Docker image; cold start can be slow on first export
- Sessions persisted to `dbo.Sessions` via `mssqlSessionStore.js` — horizontal scaling requires a shared SQL Server instance (already supported) or a Redis store
- Tesseract OCR quality depends on image resolution; low-res images may produce partial text
- No bulk entity import / spreadsheet upload (unlike LMS)
- No real-time extraction progress WebSocket — polling via `/projects/:id/sources/done-ids` JSON endpoint
- No audit log for entity edits
- Roadmap task drag-and-drop not implemented (use reorder AJAX endpoints)
- Insight generation toast relies on `window.tiqFetchJson`; if that helper is missing the form falls back to a normal POST (no toast, full reload)
