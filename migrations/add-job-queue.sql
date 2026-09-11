-- ═══════════════════════════════════════════════════════════
-- ADD JOB QUEUE FOR WRITE OPERATIONS
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS connector_jobs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,  -- Idempotency key
    action TEXT NOT NULL,              -- 'customer.create', 'invoice.create', etc.
    payload TEXT NOT NULL,             -- JSON payload
    status TEXT DEFAULT 'pending',     -- 'pending', 'processing', 'completed', 'failed'
    result TEXT,                       -- JSON result from connector
    error TEXT,                        -- Error message if failed
    attempts INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX idx_connector_jobs_tenant_company ON connector_jobs(tenant_id, company_id);
CREATE INDEX idx_connector_jobs_status ON connector_jobs(status);
CREATE INDEX idx_connector_jobs_request_id ON connector_jobs(request_id);
CREATE INDEX idx_connector_jobs_created ON connector_jobs(created_at);

-- Apply this migration:
-- wrangler d1 execute sagebridge-db --remote --file=./migrations/add-job-queue.sql
