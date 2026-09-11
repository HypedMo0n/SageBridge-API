-- Add payload identity and claim metadata for durable cloud idempotency.
ALTER TABLE connector_jobs ADD COLUMN payload_hash TEXT;
ALTER TABLE connector_jobs ADD COLUMN claimed_at DATETIME;
ALTER TABLE connector_jobs ADD COLUMN claim_expires_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_connector_jobs_idempotency_scope
ON connector_jobs(tenant_id, company_id, request_id);
