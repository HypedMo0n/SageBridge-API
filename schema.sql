-- ═══════════════════════════════════════════════════════════
-- SageBridge Cloudflare D1 Database Schema
-- Multi-tenant Sage 50 mobile backend
-- ═══════════════════════════════════════════════════════════

-- ┌─────────────────────────────────────────────────────────┐
-- │ TENANTS & COMPANIES                                     │
-- └─────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    sage_company_name TEXT NOT NULL,
    sage_company_path TEXT,
    connector_status TEXT DEFAULT 'disconnected',
    last_sync_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_companies_tenant ON companies(tenant_id);

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

CREATE INDEX idx_connectors_tenant ON connectors(tenant_id);
CREATE INDEX idx_connectors_credential_hash ON connectors(credential_hash);

-- ┌─────────────────────────────────────────────────────────┐
-- │ USERS & AUTHENTICATION                                  │
-- └─────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    role TEXT DEFAULT 'user',
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    company_id TEXT,
    key_hash TEXT NOT NULL,
    name TEXT,
    last_used_at DATETIME,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

-- ┌─────────────────────────────────────────────────────────┐
-- │ SAGE 50 DATA - CUSTOMERS                                │
-- └─────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    sage_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    contact TEXT,
    phone TEXT,
    alternate_phone TEXT,
    fax TEXT,
    credit_limit REAL,
    balance REAL,
    home_currency_balance REAL,
    status TEXT,
    address TEXT,
    city TEXT,
    province TEXT,
    postal_code TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    UNIQUE(tenant_id, company_id, sage_id)
);

CREATE INDEX idx_customers_tenant_company ON customers(tenant_id, company_id);
CREATE INDEX idx_customers_sage_id ON customers(sage_id);
CREATE INDEX idx_customers_name ON customers(name);

-- ┌─────────────────────────────────────────────────────────┐
-- │ SAGE 50 DATA - INVOICES                                │
-- └─────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    sage_id TEXT NOT NULL,
    customer_id INTEGER,
    customer_sage_id TEXT,
    invoice_number TEXT NOT NULL,
    reference TEXT,
    date DATE NOT NULL,
    pre_tax_total REAL,
    total REAL,
    balance REAL,
    home_currency_total REAL,
    home_currency_balance REAL,
    transaction_currency_total REAL,
    transaction_currency_balance REAL,
    description TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
    UNIQUE(tenant_id, company_id, sage_id)
);

CREATE INDEX idx_invoices_tenant_company ON invoices(tenant_id, company_id);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_date ON invoices(date);

-- ┌─────────────────────────────────────────────────────────┐
-- │ SAGE 50 DATA - PRODUCTS                                │
-- └─────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    sage_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    unit TEXT,
    price REAL,
    stock INTEGER,
    reorder_level INTEGER,
    category TEXT,
    is_service BOOLEAN,
    status TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    UNIQUE(tenant_id, company_id, sage_id)
);

CREATE INDEX idx_products_tenant_company ON products(tenant_id, company_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_name ON products(name);

-- ┌─────────────────────────────────────────────────────────┐
-- │ SAGE 50 DATA - PROJECTS                                │
-- └─────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    sage_id TEXT NOT NULL,
    name TEXT NOT NULL,
    customer_id INTEGER,
    customer_sage_id TEXT,
    budget REAL DEFAULT 0,
    spent REAL DEFAULT 0,
    progress INTEGER DEFAULT 0,
    status TEXT DEFAULT 'Active',
    start_date DATE,
    end_date DATE,
    description TEXT,
    last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
    UNIQUE(tenant_id, company_id, sage_id)
);

CREATE INDEX idx_projects_tenant_company ON projects(tenant_id, company_id);
CREATE INDEX idx_projects_customer ON projects(customer_id);
CREATE INDEX idx_projects_status ON projects(status);

-- ┌─────────────────────────────────────────────────────────┐
-- │ SYNC & AUDIT                                            │
-- └─────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS sync_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    records_synced INTEGER DEFAULT 0,
    status TEXT DEFAULT 'success',
    error_message TEXT,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX idx_sync_events_tenant_company ON sync_events(tenant_id, company_id);
CREATE INDEX idx_sync_events_date ON sync_events(synced_at);

-- ┌─────────────────────────────────────────────────────────┐
-- │ CONNECTOR JOBS                                          │
-- └─────────────────────────────────────────────────────────┘

CREATE TABLE IF NOT EXISTS connector_jobs (
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

CREATE INDEX idx_connector_jobs_tenant_company ON connector_jobs(tenant_id, company_id);
CREATE INDEX idx_connector_jobs_status ON connector_jobs(status);
CREATE INDEX idx_connector_jobs_created ON connector_jobs(created_at);

-- ┌─────────────────────────────────────────────────────────┐
-- │ INITIAL DEMO DATA                                       │
-- └─────────────────────────────────────────────────────────┘

-- Demo tenant
INSERT OR IGNORE INTO tenants (id, name, plan, status) 
VALUES ('demo-tenant', 'Demo Company', 'free', 'active');

-- Demo company
INSERT OR IGNORE INTO companies (id, tenant_id, sage_company_name, connector_status) 
VALUES ('demo-company', 'demo-tenant', 'Demo Construction Ltd.', 'connected');

-- Demo customers
INSERT OR IGNORE INTO customers (tenant_id, company_id, sage_id, name, email, phone, balance, status) 
VALUES 
  ('demo-tenant', 'demo-company', 'CUST001', 'ABC Construction', 'contact@abc-const.ca', '604-555-0101', 2450.75, 'Active'),
  ('demo-tenant', 'demo-company', 'CUST002', 'XYZ Renovations', 'info@xyz-reno.ca', '604-555-0102', 0, 'Active'),
  ('demo-tenant', 'demo-company', 'CUST003', 'Northern Builders', 'admin@northernbuilders.ca', '604-555-0103', 8750.25, 'Active'),
  ('demo-tenant', 'demo-company', 'CUST004', 'West Coast Contracting', 'hello@westcoast.ca', '604-555-0104', -340.00, 'Active');

-- Demo invoices
INSERT OR IGNORE INTO invoices (tenant_id, company_id, sage_id, customer_sage_id, invoice_number, date, total, balance)
VALUES
  ('demo-tenant', 'demo-company', 'INV001', 'CUST001', 'INV-1001', '2026-09-01', 2450.75, 2450.75),
  ('demo-tenant', 'demo-company', 'INV002', 'CUST003', 'INV-1002', '2026-09-05', 8750.25, 8750.25),
  ('demo-tenant', 'demo-company', 'INV003', 'CUST002', 'INV-1003', '2026-08-28', 1200.00, 0);

-- Demo products
INSERT OR IGNORE INTO products (tenant_id, company_id, sage_id, sku, name, price, stock, reorder_level, category, is_service) 
VALUES 
  ('demo-tenant', 'demo-company', 'PROD001', 'WGT-2000', 'Widget Pro 2000', 24.99, 145, 50, 'Products', 0),
  ('demo-tenant', 'demo-company', 'PROD002', 'WGT-PREM', 'Premium Widget', 49.99, 23, 30, 'Products', 0),
  ('demo-tenant', 'demo-company', 'SRV001', 'SRV-CONS', 'Consulting Hour', 150.00, NULL, NULL, 'Services', 1);
