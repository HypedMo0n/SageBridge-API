# 🌩️ SageBridge Cloudflare Workers API

**Multi-tenant cloud backend for the SageBridge mobile/web app and Windows Connector**

---

## 🎯 What This Does

This is the **cloud API layer** that:
- ✅ Authenticates app users via Firebase ID tokens
- ✅ Pairs and authenticates Windows Connectors via one-time pairing codes and per-connector credentials
- ✅ Queues write requests (e.g. `customer.create`, `quote.create`) for the connector to execute against Sage 50
- ✅ Receives sync data pushed from Windows Connectors and stores it in Cloudflare D1 (SQLite)
- ✅ Serves read data to the mobile/web app via REST
- ✅ Enforces multi-tenant isolation (organization → company scoping) on every query

---

## 🏗️ Architecture

```
📱 Mobile / Web App  --(Firebase ID token)-->  ☁️ Cloudflare Workers API  <--(connector credential)--  🔄 Windows Connector
                                                        ↓
                                                💾 Cloudflare D1 (SQLite)
                                                        ↑
                                              🖥️ Official Sage 50 SDK (via Connector)
```

Writes (e.g. creating a customer) are never applied directly to Sage 50 by this API. The app enqueues a job; the paired
connector for that company claims it, executes it against Sage 50 with the official SDK, and reports the terminal result
back to the API.

---

## 📦 What's Included

```
sagebridge-api/
├── src/
│   ├── index.ts                  # Worker entry point + CORS wrapper
│   ├── router.ts                 # Route table
│   ├── security/
│   │   ├── firebase-jwt.ts       # RS256 verification of Firebase ID tokens
│   │   ├── access.ts             # requireUser / requireConnector / tenant scoping
│   │   └── security.ts           # HttpError, hashing, bounded JSON parsing, validators
│   ├── handlers/
│   │   ├── health.ts             # Health check
│   │   ├── phase1.ts             # Bootstrap, organizations, companies, pairing, provisioning
│   │   ├── customers.ts          # Customer read + create-job endpoints
│   │   ├── invoices.ts           # Invoice endpoints
│   │   ├── products.ts           # Product endpoints
│   │   ├── quotes.ts             # Quote create-job endpoint
│   │   ├── jobs.ts               # Frontend-facing job status endpoint
│   │   ├── connector.ts          # Connector-facing job queue (list/claim/result)
│   │   └── sync.ts               # Connector → cloud data sync endpoints
│   └── utils/
│       ├── cors.ts               # Origin allowlist (FRONTEND_ORIGINS)
│       ├── response.ts           # JSON response helper
│       └── idempotency.ts        # Payload-fingerprinted idempotency keys
├── schema.sql                    # Base D1 schema
├── migrations/                   # Incremental D1 migrations (run in order)
├── wrangler.toml                 # Cloudflare config
└── test/                         # node:test suite (unit + Miniflare integration)
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Login to Cloudflare
```bash
npx wrangler login
```

### 3. Create D1 Database
```bash
npx wrangler d1 create sagebridge-db
```

**Copy the database ID** from output, update `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "sagebridge-db"
database_id = "YOUR_DATABASE_ID_HERE"  # Paste the ID here
```

### 4. Create Tables
```bash
npx wrangler d1 execute sagebridge-db --file=./schema.sql
# then apply each file in migrations/ in order
```

### 5. Configure required variables
Set in `wrangler.toml` `[vars]` (or `wrangler secret put` for anything sensitive):
- `FIREBASE_PROJECT_ID` — the Firebase project used to issue user ID tokens
- `FRONTEND_ORIGINS` — comma-separated list of allowed CORS origins

### 6. Deploy to Cloudflare
```bash
npm run deploy
```

---

## 🧪 Test

```bash
npm test          # unit + Miniflare integration tests (test/*.test.ts)
npx tsc --noEmit   # typecheck
```

### Health Check
```bash
curl https://sagebridge-api.YOUR_SUBDOMAIN.workers.dev/health
```

---

## 📊 API Endpoints

### Public
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/connector/pairing/validate` or `/auth/pairing/exchange` | Exchange a pairing code for connector credentials |

### App user endpoints (require `Authorization: Bearer <Firebase ID token>`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/bootstrap` | First-login bootstrap: creates the user's org/company if needed |
| GET | `/auth/me` | Current user + organization memberships |
| GET | `/api/organizations/{organizationId}/companies` | List companies in an organization |
| POST | `/api/organizations/{organizationId}/companies` | Create a company (owner/admin) |
| POST | `/api/companies/{companyId}/pairing-codes` | Generate a one-time connector pairing code (owner/admin) |
| GET | `/api/companies/{companyId}/connectors` | List connectors paired to a company |
| GET | `/api/companies/{companyId}/provisioning` | Read provisioning status |
| POST | `/api/companies/{companyId}/provisioning` | Start/retry provisioning once a connector is online (owner/admin) |
| POST | `/(api/)connectors/{id}/revoke` | Revoke a connector (owner/admin) |

The endpoints below additionally require an `X-Company-Id` header identifying a company the caller belongs to:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/customers` | List customers |
| GET | `/api/customers/{id}` | Get a single customer |
| POST | `/api/customers` | Enqueue a `customer.create` job (body: `{ customer, idempotencyKey }`) |
| GET | `/api/invoices` | List invoices |
| GET | `/api/invoices/{id}` | Get a single invoice |
| GET | `/api/products` | List products/services |
| POST | `/api/quotes` | Enqueue a `quote.create` job (body: `{ quote, idempotencyKey }`) |
| GET | `/api/jobs/{id}` | Get the status/result of a queued job |

### Connector endpoints (require `X-Connector-Id` + `X-Connector-Credential` headers)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/connector/heartbeat` | Report liveness + Sage connection status |
| POST | `/connector/provisioning` | Report provisioning state/progress |
| GET | `/connector/jobs` | List claimable jobs for this connector's company |
| POST | `/connector/jobs/{id}/start` | Claim a job |
| POST | `/connector/jobs/{id}/result` | Submit a job's terminal result |
| POST | `/sync/customers` \| `/sync/invoices` \| `/sync/products` \| `/sync/quotes` \| `/sync/invoice-summary` | Push a full snapshot from Sage 50 |

---

## 🔐 Authentication

There is no shared API key. Two independent, scoped credential types are used:

### App users — Firebase ID tokens
The app authenticates users with Firebase Auth and sends the resulting ID token as `Authorization: Bearer <token>` on
every request. The Worker verifies the token's RS256 signature against Google's published JWKs, and checks issuer,
audience (`FIREBASE_PROJECT_ID`), expiry, and `email_verified`. A verified user is mapped to a stable internal user id;
unverified emails are rejected with `403 EMAIL_NOT_VERIFIED`.

### Windows Connector — pairing + per-connector credential
1. An owner/admin generates a short-lived, single-use pairing code from the app (`POST /api/companies/{id}/pairing-codes`).
2. The connector exchanges that code once (`POST /connector/pairing/validate`) for a `connectorId` + `credential`.
3. The credential is stored hashed (SHA-256) server-side; the connector presents it on every subsequent request via
   `X-Connector-Id` / `X-Connector-Credential`. Credentials can be revoked per-connector at any time.

All tenant-scoped queries filter by both `organization_id` (tenant) and `company_id`, resolved from the authenticated
caller — never from client-supplied identifiers alone.

---

## 🗄️ Database Schema

### Multi-Tenant Design
Every tenant-scoped table includes:
- `tenant_id` / `organization_id` — the organization that owns the data
- `company_id` — the Sage 50 company within that organization

**Critical:** every read/write query filters by both, derived from the authenticated caller.

### Tables
- **tenants / organizations** — accounts and their membership
- **companies** — Sage 50 companies within an organization
- **users** — app users (mapped from Firebase UID)
- **connectors / connector_credentials / pairing_codes** — Windows Connector pairing and credentials
- **connector_jobs** — the write job queue (`customer.create`, `quote.create`, …) with idempotency keys
- **provisioning** — per-company onboarding state machine
- **customers / invoices / products / quotes / invoice_summaries** — synced Sage 50 data
- **sync_events / audit_events** — sync and security audit logs
- **rate_limit_counters** — fixed-window rate limiting for pairing endpoints

---

## 🔄 How Sync Works

### 1. Connector pushes a full snapshot
```bash
curl -X POST https://api.sagebridge.workers.dev/sync/customers \
  -H "X-Connector-Id: conn_..." \
  -H "X-Connector-Credential: sbc_..." \
  -H "Content-Type: application/json" \
  -d '{
    "Customers": [
      { "Id": "CUST001", "Name": "ABC Construction", "Email": "contact@abc.com", "Balance": 2450.75 }
    ]
  }'
```

### 2. Workers upserts into D1
```sql
INSERT INTO customers (...)
VALUES (...)
ON CONFLICT(tenant_id, company_id, sage_id)
DO UPDATE SET ...
```

### 3. App reads data
```javascript
fetch('https://api.sagebridge.workers.dev/api/customers', {
  headers: { Authorization: `Bearer ${firebaseIdToken}`, 'X-Company-Id': companyId }
})
```

---

## 🌍 Deploy to Production

### 1. Set a custom domain (optional)
```bash
# Add route in Cloudflare dashboard:
# api.sagebridge.io → sagebridge-api worker
```

### 2. Deploy
```bash
npm run deploy
```

---

## 💰 Cost (Cloudflare Free Tier)

| Resource | Free Tier | SageBridge Usage |
|----------|-----------|------------------|
| Workers | 100,000 requests/day | ✅ Enough for 10K+ users |
| D1 Database | 5GB storage | ✅ Millions of records |
| D1 Reads | 5M/day | ✅ High traffic OK |
| D1 Writes | 100K/day | ✅ Frequent syncs OK |

---

## 🛠️ Development

### Run Locally
```bash
npm run dev
# API available at http://localhost:8787
```

### Test Against Local D1
```bash
npm run dev
npx wrangler d1 execute sagebridge-db --local --command="SELECT * FROM customers"
```

### View Logs
```bash
npm run tail
```

---

## 🚨 Security Checklist

- [x] CORS restricted to an explicit `FRONTEND_ORIGINS` allowlist
- [x] Firebase ID token verification (signature, issuer, audience, expiry, `email_verified`)
- [x] Per-connector hashed credentials, independently revocable
- [x] Tenant/company isolation enforced on every query from the authenticated caller's own scope
- [x] Idempotency keys bound to a payload fingerprint (replay with a different payload is rejected)
- [x] Rate limiting on pairing code creation and exchange
- [x] Bounded JSON request bodies
- [ ] Structured audit log review / alerting (audit_events table exists; no alerting yet)
- [ ] Automated key rotation for connector credentials

---

**Built for SageBridge - Your Sage 50, Everywhere 🌉**
