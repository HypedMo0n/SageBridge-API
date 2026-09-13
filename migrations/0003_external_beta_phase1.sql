-- External Beta Phase 1 identity, organization and connector security foundation.
-- Forward-only migration. Back up before applying. The FK toggle is required while
-- rebuilding users/connector_jobs and is restored and checked at the end.
PRAGMA foreign_keys=OFF;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'beta',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO organizations(id,name,plan,status,created_at,updated_at)
SELECT id,name,plan,status,created_at,updated_at FROM tenants;

CREATE TABLE users_v2 (
  id TEXT PRIMARY KEY,
  auth_provider TEXT NOT NULL,
  auth_subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(auth_provider,auth_subject)
);
INSERT INTO users_v2(id,auth_provider,auth_subject,email,display_name,status,created_at,updated_at)
SELECT id,'legacy',id,email,name,
       CASE WHEN status='active' THEN 'active' ELSE 'disabled' END,
       created_at,updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;
CREATE UNIQUE INDEX users_auth_identity ON users(auth_provider,auth_subject);

CREATE TABLE organization_memberships (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(organization_id,user_id),
  FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

ALTER TABLE companies ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE companies ADD COLUMN last_seen_at TEXT;
UPDATE companies SET organization_id=tenant_id WHERE organization_id IS NULL;
CREATE INDEX companies_org ON companies(organization_id);
CREATE UNIQUE INDEX companies_org_id ON companies(organization_id,id);
CREATE TRIGGER companies_org_required_insert BEFORE INSERT ON companies
WHEN NEW.organization_id IS NULL OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT,'valid organization_id required'); END;
CREATE TRIGGER companies_org_required_update BEFORE UPDATE OF organization_id ON companies
WHEN NEW.organization_id IS NULL OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id)
BEGIN SELECT RAISE(ABORT,'valid organization_id required'); END;

CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  installation_id TEXT,
  display_name TEXT,
  version TEXT,
  machine_name TEXT,
  connector_version TEXT,
  sage_version TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  last_seen_at TEXT,
  last_sync_at TEXT,
  paired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provisioning_state TEXT NOT NULL DEFAULT 'connector_connected',
  health_json TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id,installation_id),
  FOREIGN KEY(organization_id,company_id) REFERENCES companies(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE connector_credentials (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(connector_id) REFERENCES connectors(id) ON DELETE CASCADE
);
CREATE TABLE pairing_codes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','consumed','revoked','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(organization_id,company_id) REFERENCES companies(organization_id,id),
  FOREIGN KEY(created_by_user_id) REFERENCES users(id)
);
CREATE TABLE provisioning (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('awaiting_connector','connector_connected','checking_sage','company_selected','provisioning','syncing_customers','syncing_invoices','syncing_products','syncing_quotes','finalizing','ready','failed')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(organization_id,company_id),
  FOREIGN KEY(organization_id,company_id) REFERENCES companies(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT, company_id TEXT,
  actor_type TEXT NOT NULL, actor_id TEXT,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT,
  outcome TEXT NOT NULL, request_id TEXT, ip_hash TEXT, metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_scope ON audit_events(organization_id,company_id,created_at);
CREATE TABLE rate_limit_counters (
  bucket_key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL,
  expires_at TEXT NOT NULL, PRIMARY KEY(bucket_key,window_start)
);

CREATE TABLE quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  sage_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id,company_id,sage_id),
  FOREIGN KEY(tenant_id,company_id) REFERENCES companies(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX quotes_scope ON quotes(tenant_id,company_id);

CREATE TABLE invoice_summaries (
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(tenant_id,company_id),
  FOREIGN KEY(tenant_id,company_id) REFERENCES companies(organization_id,id) ON DELETE CASCADE
);

ALTER TABLE connector_jobs RENAME TO connector_jobs_legacy;
CREATE TABLE connector_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('customer.create','quote.create')),
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
INSERT INTO connector_jobs(id,tenant_id,company_id,request_id,action,payload,payload_hash,status,result,error,attempts,created_at,started_at,claimed_at,claim_expires_at,completed_at)
SELECT id,tenant_id,company_id,request_id,action,payload,payload_hash,
       CASE status WHEN 'processing' THEN 'running' WHEN 'completed' THEN 'succeeded' ELSE status END,
       result,error,attempts,created_at,started_at,claimed_at,claim_expires_at,completed_at
FROM connector_jobs_legacy;
DROP TABLE connector_jobs_legacy;
CREATE INDEX connector_jobs_claim ON connector_jobs(tenant_id,company_id,status,claim_expires_at);

PRAGMA foreign_keys=ON;
PRAGMA foreign_key_check;
