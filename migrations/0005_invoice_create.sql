-- Allow 'invoice.create' as a connector_jobs action. SQLite CHECK constraints
-- cannot be altered in place, so the table is rebuilt exactly as in
-- 0003_external_beta_phase1.sql with the widened action list.
ALTER TABLE connector_jobs RENAME TO connector_jobs_pre_invoice;
CREATE TABLE connector_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('customer.create','quote.create','invoice.create')),
  payload TEXT NOT NULL,
  payload_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','running','succeeded','failed')),
  result TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  connector_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT, claimed_at TEXT, claim_expires_at TEXT, completed_at TEXT,
  FOREIGN KEY(tenant_id,company_id) REFERENCES companies(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY(connector_id) REFERENCES connectors(id),
  UNIQUE(tenant_id,company_id,request_id)
);
INSERT INTO connector_jobs(id,tenant_id,company_id,request_id,action,payload,payload_hash,status,result,error,attempts,max_attempts,connector_id,created_at,started_at,claimed_at,claim_expires_at,completed_at)
SELECT id,tenant_id,company_id,request_id,action,payload,payload_hash,status,result,error,attempts,max_attempts,connector_id,created_at,started_at,claimed_at,claim_expires_at,completed_at
FROM connector_jobs_pre_invoice;
DROP TABLE connector_jobs_pre_invoice;
CREATE INDEX connector_jobs_claim ON connector_jobs(tenant_id,company_id,status,claim_expires_at);
