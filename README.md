# TransformIQ — Association Edition

AI-powered business transformation platform. Upload meeting transcripts, reports, and documents; let Claude extract entities, build a knowledge graph, and generate professional deliverables.

## What it does

| Stage | Action |
|---|---|
| **Capture** | Upload PDF, DOCX, XLSX, TXT, or image files as project sources |
| **Extract** | Claude (`claude-opus-4-7`) extracts 8 entity types per document |
| **Graph** | Business Impact Map — entities connected through inferred relationships (Cytoscape.js); Requirements Traceability table |
| **Visualise** | Process maps, RACI matrix, stakeholder map, risk heatmap, gap analysis |
| **Insights** | Future state, roadmap, user stories, acceptance criteria, impact matrix |
| **Export** | BRD, FRD, Risk Register (Excel), Executive Summary (Word or PDF), Future State doc |
| **Admin** | Data health report — orphaned projects, unlinked files, missing memberships |

## Entity types extracted

Requirements · Stakeholders · Processes · Decisions · Risks · Business Rules · Systems · KPIs

## Quick start

```bash
git clone https://github.com/victorolusholawr-hue/TransformIQASSN.git
cd TransformIQASSN
cp .env.example .env
# Edit .env: set SESSION_SECRET, DB_PASSWORD, ANTHROPIC_API_KEY
docker compose up --build
```

App: **http://localhost:8082** &nbsp;·&nbsp; SQL Server: `localhost:1434`

Register the first user, then promote to admin via SQL if needed:
```sql
UPDATE dbo.Users SET role = 'admin' WHERE email = 'you@example.com';
```

## Tech stack

- **Runtime:** Node.js 20, Express 4
- **Templates:** EJS via `express-ejs-layouts`
- **Database:** SQL Server 2022 (Docker) — `mssql` (Tedious driver)
- **AI:** Anthropic Claude API — `@anthropic-ai/sdk`
- **File parsing:** `pdf-parse`, `mammoth`, `xlsx`, `tesseract.js`
- **Exports:** `docx`, `exceljs`, `puppeteer`
- **Storage:** Azure Blob (production) · local disk (dev)

## Environment variables

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Express session key (min 32 chars) |
| `DB_PASSWORD` | SQL Server SA password |
| `ANTHROPIC_API_KEY` | Claude API key (`sk-ant-...`) |
| `ANTHROPIC_MODEL` | Claude model ID (default `claude-opus-4-7`) |
| `AI_CHUNK_SIZE` | Characters per extraction chunk (default 6000) |
| `AI_MAX_CHUNKS` | Max chunks per source (default 25) |
| `SESSION_STORE` | Set to `memory` to skip MSSQL session persistence |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Blob — leave blank for local dev |

See [`.env.example`](.env.example) for the full list.

## Project roles

| Role | Permissions |
|---|---|
| `owner` | Full access + delete/archive/restore project + manage members |
| `analyst` | Upload sources, trigger extraction, edit entities, generate insights |
| `viewer` | Read-only access to all project data (cannot trigger extraction) |

## Data health (admin only)

Admins see a **Data Health** link in the navbar (`/admin/data-health`) with a read-only integrity report:

- Projects with missing membership records (invisible to users on the dashboard)
- Local source files not linked to a `dbo.Sources` row
- Export files not linked to a `dbo.Documents` row
- Entity rows referencing deleted sources

Missing owner memberships are auto-repaired on every app startup. Unlinked source files are auto-recovered on startup when the context is unambiguous (one active project, zero existing source rows). The CLI script `scripts/data-health.js` supports `--repair-memberships` and `--recover-sources [--dry-run]` for manual repair.

## Project management

Projects can be **archived** (soft-delete, hidden from active lists) or **permanently deleted** via the Danger Zone on the edit page. Deletion cascades all sources, entities, graph data, and exports.

## Development

```bash
npm install
# Requires SQL Server on localhost:1433 — or use Docker:
docker compose up db -d
node app.js
```

Hot reload:
```bash
npm run dev   # uses nodemon
```

## Docker

```bash
# Build and start both services
docker compose up --build

# Stop (preserves DB volume)
docker compose down

# Full reset including database
docker compose down -v && docker compose up --build
```

SQL Server data persisted in Docker volume `db-data`.

## Repository

**GitHub:** https://github.com/victorolusholawr-hue/TransformIQASSN
