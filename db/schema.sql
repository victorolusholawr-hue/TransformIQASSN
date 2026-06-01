-- TransformIQ Association — MSSQL Schema
-- All CREATE statements are idempotent (IF NOT EXISTS / IF OBJECT_ID IS NULL)

-- ============================================================
-- Users
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Users' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Users (
    id            UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    name          NVARCHAR(255)    NOT NULL,
    email         NVARCHAR(255)    NOT NULL,
    password_hash NVARCHAR(255)    NULL,
    role          NVARCHAR(50)     NOT NULL DEFAULT 'analyst', -- analyst|viewer|admin
    created_at    DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_Users_email UNIQUE (email)
);

-- ============================================================
-- Sessions
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Sessions' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Sessions (
    sid        NVARCHAR(255) NOT NULL PRIMARY KEY,
    sess       NVARCHAR(MAX) NOT NULL,
    expires_at DATETIME2     NOT NULL,
    updated_at DATETIME2     NOT NULL DEFAULT GETUTCDATE()
);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Sessions_expires_at' AND object_id = OBJECT_ID('dbo.Sessions'))
CREATE INDEX IX_Sessions_expires_at ON dbo.Sessions(expires_at);

-- ============================================================
-- Projects
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Projects' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Projects (
    id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    name        NVARCHAR(255)    NOT NULL,
    description NVARCHAR(MAX)    NULL,
    owner_id    UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Users(id),
    status      NVARCHAR(50)     NOT NULL DEFAULT 'active', -- active|archived
    tags        NVARCHAR(MAX)    NULL, -- JSON array
    created_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Project Members
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ProjectMembers' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.ProjectMembers (
    id         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    user_id    UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Users(id),
    role       NVARCHAR(50)     NOT NULL DEFAULT 'analyst', -- owner|analyst|viewer
    joined_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_ProjectMembers UNIQUE (project_id, user_id)
);

-- ============================================================
-- Sources
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Sources' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Sources (
    id                UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id        UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    name              NVARCHAR(500)    NOT NULL,
    source_type       NVARCHAR(100)    NULL,
    file_url          NVARCHAR(1000)   NULL,
    file_ext          NVARCHAR(20)     NULL,
    extracted_text    NVARCHAR(MAX)    NULL,
    extraction_status NVARCHAR(50)     NOT NULL DEFAULT 'pending', -- pending|done|failed
    ai_status         NVARCHAR(50)     NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
    chunks_total      INT              NOT NULL DEFAULT 0,
    participants      NVARCHAR(MAX)    NULL, -- JSON array
    source_date       NVARCHAR(100)    NULL,
    uploader_id       UNIQUEIDENTIFIER NULL REFERENCES dbo.Users(id),
    metadata          NVARCHAR(MAX)    NULL, -- JSON: word_count, page_count, extraction_method
    created_at        DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Requirements
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Requirements' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Requirements (
    id                   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id           UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_id            UNIQUEIDENTIFIER NULL REFERENCES dbo.Sources(id),
    req_type             NVARCHAR(50)     NULL, -- functional|non-functional
    title                NVARCHAR(500)    NOT NULL,
    description          NVARCHAR(MAX)    NULL,
    priority             NVARCHAR(50)     NULL, -- high|medium|low
    status               NVARCHAR(50)     NOT NULL DEFAULT 'pending', -- pending|confirmed|rejected
    confidence           DECIMAL(3,2)     NULL,
    source_quote         NVARCHAR(500)    NULL,
    duplicate_candidates NVARCHAR(MAX)    NULL, -- JSON array of IDs
    needs_review         BIT              NOT NULL DEFAULT 0,
    created_at           DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Processes
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Processes' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Processes (
    id             UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id     UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_id      UNIQUEIDENTIFIER NULL REFERENCES dbo.Sources(id),
    name           NVARCHAR(255)    NOT NULL,
    description    NVARCHAR(MAX)    NULL,
    steps          NVARCHAR(MAX)    NULL, -- JSON array of {order, action, actor}
    mermaid_syntax NVARCHAR(MAX)    NULL,
    confidence     DECIMAL(3,2)     NULL,
    source_quote   NVARCHAR(500)    NULL,
    created_at     DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Stakeholders
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Stakeholders' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Stakeholders (
    id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id   UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_id    UNIQUEIDENTIFIER NULL REFERENCES dbo.Sources(id),
    name         NVARCHAR(255)    NOT NULL,
    role         NVARCHAR(255)    NULL,
    organization NVARCHAR(255)    NULL,
    influence    INT              NULL, -- 1-5
    interest     INT              NULL, -- 1-5
    confidence   DECIMAL(3,2)     NULL,
    source_quote NVARCHAR(500)    NULL,
    duplicate_candidates NVARCHAR(MAX) NULL, -- JSON array of IDs
    needs_review BIT              NOT NULL DEFAULT 0,
    created_at   DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

IF COL_LENGTH('dbo.Stakeholders', 'duplicate_candidates') IS NULL
ALTER TABLE dbo.Stakeholders ADD duplicate_candidates NVARCHAR(MAX) NULL;

IF COL_LENGTH('dbo.Stakeholders', 'needs_review') IS NULL
ALTER TABLE dbo.Stakeholders ADD needs_review BIT NOT NULL CONSTRAINT DF_Stakeholders_needs_review DEFAULT 0;

-- ============================================================
-- Decisions
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Decisions' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Decisions (
    id              UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id      UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_id       UNIQUEIDENTIFIER NULL REFERENCES dbo.Sources(id),
    title           NVARCHAR(500)    NOT NULL,
    description     NVARCHAR(MAX)    NULL,
    rationale       NVARCHAR(MAX)    NULL,
    decision_maker  NVARCHAR(255)    NULL,
    status          NVARCHAR(50)     NOT NULL DEFAULT 'proposed', -- proposed|approved|deferred|rejected
    confidence      DECIMAL(3,2)     NULL,
    source_quote    NVARCHAR(500)    NULL,
    created_at      DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Risks
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Risks' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Risks (
    id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id   UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_id    UNIQUEIDENTIFIER NULL REFERENCES dbo.Sources(id),
    title        NVARCHAR(500)    NOT NULL,
    description  NVARCHAR(MAX)    NULL,
    category     NVARCHAR(50)     NULL, -- technical|business|resource|schedule|regulatory
    likelihood   INT              NULL, -- 1-5
    impact       INT              NULL, -- 1-5
    mitigation   NVARCHAR(MAX)    NULL,
    owner        NVARCHAR(255)    NULL,
    confidence   DECIMAL(3,2)     NULL,
    source_quote NVARCHAR(500)    NULL,
    created_at   DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Business Rules
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'BusinessRules' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.BusinessRules (
    id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id   UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_id    UNIQUEIDENTIFIER NULL REFERENCES dbo.Sources(id),
    title        NVARCHAR(500)    NOT NULL,
    description  NVARCHAR(MAX)    NULL,
    category     NVARCHAR(50)     NULL, -- validation|calculation|authorization|constraint|other
    confidence   DECIMAL(3,2)     NULL,
    source_quote NVARCHAR(500)    NULL,
    created_at   DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Systems
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Systems' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Systems (
    id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id   UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_id    UNIQUEIDENTIFIER NULL REFERENCES dbo.Sources(id),
    name         NVARCHAR(255)    NOT NULL,
    system_type  NVARCHAR(50)     NULL, -- existing|proposed|external
    description  NVARCHAR(MAX)    NULL,
    integrations NVARCHAR(MAX)    NULL, -- JSON array of system names
    confidence   DECIMAL(3,2)     NULL,
    source_quote NVARCHAR(500)    NULL,
    created_at   DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- KPIs
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'KPIs' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.KPIs (
    id                 UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id         UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_id          UNIQUEIDENTIFIER NULL REFERENCES dbo.Sources(id),
    name               NVARCHAR(255)    NOT NULL,
    description        NVARCHAR(MAX)    NULL,
    target_value       NVARCHAR(255)    NULL,
    measurement_method NVARCHAR(MAX)    NULL,
    frequency          NVARCHAR(50)     NULL, -- daily|weekly|monthly|quarterly|yearly
    owner              NVARCHAR(255)    NULL,
    confidence         DECIMAL(3,2)     NULL,
    source_quote       NVARCHAR(500)    NULL,
    created_at         DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Graph Edges
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'GraphEdges' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.GraphEdges (
    id               UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id       UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    source_node_id   NVARCHAR(36)     NOT NULL,
    source_node_type NVARCHAR(50)     NOT NULL,
    target_node_id   NVARCHAR(36)     NOT NULL,
    target_node_type NVARCHAR(50)     NOT NULL,
    relationship     NVARCHAR(255)    NULL,
    weight           INT              NOT NULL DEFAULT 1,
    created_at       DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Documents (export history)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Documents' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.Documents (
    id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id   UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    doc_type     NVARCHAR(50)     NULL, -- brd|frd|executive_summary|risk_register|future_state
    file_url     NVARCHAR(1000)   NULL,
    generated_by UNIQUEIDENTIFIER NULL REFERENCES dbo.Users(id),
    generated_at DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
    version      INT              NOT NULL DEFAULT 1
);

-- ============================================================
-- AI Insights
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AIInsights' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.AIInsights (
    id           UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id   UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    type         NVARCHAR(50)     NOT NULL, -- future_state|roadmap|user_stories|acceptance_criteria|impact_matrix
    content      NVARCHAR(MAX)    NULL, -- JSON
    generated_by UNIQUEIDENTIFIER NULL REFERENCES dbo.Users(id),
    generated_at DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_AIInsights UNIQUE (project_id, type)
);

-- ============================================================
-- Roadmap Tasks
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'RoadmapTasks' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.RoadmapTasks (
    id         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    project_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Projects(id),
    phase_name NVARCHAR(255)    NOT NULL,
    req_title  NVARCHAR(500)    NOT NULL,
    status     NVARCHAR(50)     NOT NULL DEFAULT 'todo', -- todo|in_progress|done|blocker|deferred|cancelled
    owner      NVARCHAR(255)    NULL,
    due_date   DATETIME2        NULL,
    notes      NVARCHAR(MAX)    NULL,
    sort_order INT              NOT NULL DEFAULT 0,
    created_at DATETIME2        NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_RoadmapTasks UNIQUE (project_id, phase_name, req_title)
);

-- ============================================================
-- Usage Stats (monthly totals, keyed by "YYYY-MM" or "YYYY-MM|proj|<id>")
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'UsageStats' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.UsageStats (
    stat_key     NVARCHAR(100) NOT NULL PRIMARY KEY,
    input_tokens INT           NOT NULL DEFAULT 0,
    output_tokens INT          NOT NULL DEFAULT 0,
    calls        INT           NOT NULL DEFAULT 0,
    updated_at   DATETIME2     NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- Rate Events (sliding window rate limiting)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'RateEvents' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.RateEvents (
    id         UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    user_id    UNIQUEIDENTIFIER NULL REFERENCES dbo.Users(id),
    project_id UNIQUEIDENTIFIER NULL REFERENCES dbo.Projects(id),
    action     NVARCHAR(50)     NULL, -- extract|insight
    called_at  DATETIME2        NOT NULL DEFAULT GETUTCDATE()
);

-- ============================================================
-- App Settings (key-value store)
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AppSettings' AND schema_id = SCHEMA_ID('dbo'))
CREATE TABLE dbo.AppSettings (
    setting_key   NVARCHAR(100) NOT NULL PRIMARY KEY,
    setting_value NVARCHAR(MAX) NULL
);

-- Seed default AI limit settings
IF NOT EXISTS (SELECT 1 FROM dbo.AppSettings WHERE setting_key = 'ai_limits')
INSERT INTO dbo.AppSettings (setting_key, setting_value) VALUES (
    'ai_limits',
    '{"rate_limit_enabled":false,"max_insight_per_user_per_hour":10,"max_extract_per_user_per_hour":20,"max_insight_per_project_per_hour":20,"max_extract_per_project_per_hour":40,"budget_enabled":false,"max_monthly_tokens":1000000}'
);

-- Ensure every project owner is also a project member. Older/imported data can
-- be orphaned otherwise, making active projects invisible on the dashboard.
INSERT INTO dbo.ProjectMembers (id, project_id, user_id, role)
SELECT NEWID(), p.id, p.owner_id, 'owner'
FROM dbo.Projects p
WHERE NOT EXISTS (
    SELECT 1
    FROM dbo.ProjectMembers pm
    WHERE pm.project_id = p.id
      AND pm.user_id = p.owner_id
);

-- ============================================================
-- Indexes
-- ============================================================
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Projects_owner_id')
    CREATE INDEX IX_Projects_owner_id ON dbo.Projects(owner_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ProjectMembers_user_id')
    CREATE INDEX IX_ProjectMembers_user_id ON dbo.ProjectMembers(user_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Sources_project_id')
    CREATE INDEX IX_Sources_project_id ON dbo.Sources(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Requirements_project_id')
    CREATE INDEX IX_Requirements_project_id ON dbo.Requirements(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Processes_project_id')
    CREATE INDEX IX_Processes_project_id ON dbo.Processes(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Stakeholders_project_id')
    CREATE INDEX IX_Stakeholders_project_id ON dbo.Stakeholders(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Decisions_project_id')
    CREATE INDEX IX_Decisions_project_id ON dbo.Decisions(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Risks_project_id')
    CREATE INDEX IX_Risks_project_id ON dbo.Risks(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_BusinessRules_project_id')
    CREATE INDEX IX_BusinessRules_project_id ON dbo.BusinessRules(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Systems_project_id')
    CREATE INDEX IX_Systems_project_id ON dbo.Systems(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_KPIs_project_id')
    CREATE INDEX IX_KPIs_project_id ON dbo.KPIs(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_GraphEdges_project_id')
    CREATE INDEX IX_GraphEdges_project_id ON dbo.GraphEdges(project_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_RateEvents_called_at')
    CREATE INDEX IX_RateEvents_called_at ON dbo.RateEvents(called_at, user_id, project_id);
