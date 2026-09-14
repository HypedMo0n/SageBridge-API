-- Multi-company connector authentication and company-scoped job idempotency.
-- Apply after add-job-queue.sql and 0002_job_idempotency_hardening.sql.

CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    credential_hash TEXT NOT NULL UNIQUE,
    installation_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_seen_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_connectors_tenant ON connectors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_connectors_credential_hash ON connectors(credential_hash);

-- The original connector_jobs schema made request_id globally unique. That
-- incorrectly treats the same idempotency key in Company A and Company B as
-- one operation. Rebuild the table so identity is tenant + company + request.
CREATE TABLE connector_jobs_multi_company (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME,
    claimed_at DATETIME,
    claim_expires_at DATETIME,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    UNIQUE(tenant_id, company_id, request_id)
);

INSERT INTO connector_jobs_multi_company (
    id, tenant_id, company_id, request_id, action, payload, payload_hash,
    status, result, error, attempts, created_at, started_at, completed_at,
    claimed_at, claim_expires_at
)
SELECT
    id, tenant_id, company_id, request_id, action, payload, payload_hash,
    status, result, error, attempts, created_at, started_at, completed_at,
    claimed_at, claim_expires_at
FROM connector_jobs;

DROP TABLE connector_jobs;
ALTER TABLE connector_jobs_multi_company RENAME TO connector_jobs;

CREATE INDEX idx_connector_jobs_tenant_company ON connector_jobs(tenant_id, company_id);
CREATE INDEX idx_connector_jobs_status ON connector_jobs(status);
CREATE INDEX idx_connector_jobs_request_id ON connector_jobs(request_id);
CREATE INDEX idx_connector_jobs_created ON connector_jobs(created_at);
CREATE UNIQUE INDEX idx_connector_jobs_idempotency_scope
ON connector_jobs(tenant_id, company_id, request_id);
