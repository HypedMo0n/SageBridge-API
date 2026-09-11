# 🌩️ SageBridge Cloudflare Workers API

**Multi-tenant cloud backend for SageBridge mobile app**

---

## 🎯 What This Does

This is the **cloud API layer** that:
- ✅ Receives sync data from Windows Connectors
- ✅ Stores data in Cloudflare D1 (SQLite)
- ✅ Serves data to mobile apps via REST API
- ✅ Handles multi-tenant isolation (10,000+ companies)
- ✅ Runs on Cloudflare's global edge network (fast!)

---

## 🏗️ Architecture

```
📱 Mobile App
    ↓
☁️ Cloudflare Workers API (this project)
    ↓
💾 Cloudflare D1 Database (multi-tenant SQLite)
    ↑
🔄 Sync from Windows Connector
```

---

## 📦 What's Included

```
sagebridge-workers/
├── src/
│   ├── index.ts                  # Main entry point
│   ├── router.ts                 # API routes
│   ├── middleware/
│   │   └── auth.ts               # API key authentication
│   ├── handlers/
│   │   ├── health.ts             # Health check
│   │   ├── customers.ts          # Customer endpoints
│   │   ├── invoices.ts           # Invoice endpoints
│   │   ├── products.ts           # Product endpoints
│   │   └── sync.ts               # Connector sync endpoints
│   └── utils/
│       ├── cors.ts               # CORS headers
│       └── response.ts           # Response helpers
├── schema.sql                    # D1 database schema
├── wrangler.toml                 # Cloudflare config
├── package.json                  # Dependencies
└── tsconfig.json                 # TypeScript config
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
```

### 5. Deploy to Cloudflare
```bash
npm run deploy
```

**You'll get a URL like:** `https://sagebridge-api.YOUR_SUBDOMAIN.workers.dev`

---

## 🧪 Test the API

### Health Check
```bash
curl https://sagebridge-api.YOUR_SUBDOMAIN.workers.dev/health
```

**Expected response:**
```json
{
  "status": "healthy",
  "database": "connected",
  "version": "1.0.0"
}
```

### Get Customers (Demo Data)
```bash
curl https://sagebridge-api.YOUR_SUBDOMAIN.workers.dev/api/customers \
  -H "X-API-Key: demo-key"
```

**Expected:** 4 demo customers from schema

### Get Invoices
```bash
curl https://sagebridge-api.YOUR_SUBDOMAIN.workers.dev/api/invoices \
  -H "X-API-Key: demo-key"
```

### Get Products
```bash
curl https://sagebridge-api.YOUR_SUBDOMAIN.workers.dev/api/products \
  -H "X-API-Key: demo-key"
```

---

## 📊 API Endpoints

### Public Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (no auth required) |

### Mobile App Endpoints (requires `X-API-Key` header)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/customers` | List all customers |
| GET | `/api/customers/{id}` | Get single customer |
| POST | `/api/customers` | Create customer |
| GET | `/api/invoices` | List all invoices |
| GET | `/api/invoices/{id}` | Get single invoice |
| GET | `/api/products` | List all products |

### Connector Sync Endpoints (requires `X-API-Key` header)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/sync/customers` | Sync customers from connector |
| POST | `/sync/invoices` | Sync invoices from connector |
| POST | `/sync/products` | Sync products from connector |

---

## 🔐 Authentication

All endpoints (except `/health`) require an API key in the `X-API-Key` header.

### Demo Mode
Use `X-API-Key: demo-key` to access demo data.

### Production Mode
API keys should be in format: `{tenantId}_{companyId}_{randomString}`

Example: `acme-corp_main-company_a8f3j2k1m9`

---

## 🗄️ Database Schema

### Multi-Tenant Design
Every table includes:
- `tenant_id` - Organization/account ID
- `company_id` - Sage 50 company within that tenant

**Critical:** All queries MUST include both:
```sql
WHERE tenant_id = ? AND company_id = ?
```

### Tables
- **tenants** - Organizations
- **companies** - Sage 50 companies
- **users** - User accounts
- **api_keys** - API authentication
- **customers** - Sage 50 customers
- **invoices** - Sage 50 invoices
- **products** - Sage 50 products/services
- **projects** - Sage 50 projects
- **sync_events** - Sync audit log

---

## 🔄 How Sync Works

### 1. Connector Pushes Data
Windows Connector sends POST request:
```bash
curl -X POST https://api.sagebridge.workers.dev/sync/customers \
  -H "X-API-Key: demo-tenant_demo-company_key" \
  -H "Content-Type: application/json" \
  -d '{
    "TenantId": "demo-tenant",
    "CompanyId": "demo-company",
    "Customers": [
      {
        "Id": "CUST001",
        "Name": "ABC Construction",
        "Email": "contact@abc.com",
        "Balance": 2450.75
      }
    ]
  }'
```

### 2. Workers Upserts to D1
```sql
INSERT INTO customers (...)
VALUES (...)
ON CONFLICT(tenant_id, company_id, sage_id) 
DO UPDATE SET ...
```

### 3. Mobile App Pulls Data
```javascript
fetch('https://api.sagebridge.workers.dev/api/customers', {
  headers: { 'X-API-Key': 'demo-key' }
})
```

---

## 🌍 Deploy to Production

### 1. Set Custom Domain (Optional)
```bash
# Add route in Cloudflare dashboard:
# api.sagebridge.io → sagebridge-api worker
```

### 2. Set Secrets
```bash
npx wrangler secret put MASTER_API_KEY
# Enter: your-super-secret-key-here
```

### 3. Deploy
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

**Estimated cost for 10,000 companies: $0-25/month** (well within free tier for most usage)

---

## 🛠️ Development

### Run Locally
```bash
npm run dev
# API available at http://localhost:8787
```

### Test Against Local D1
```bash
# Wrangler dev uses a local SQLite DB automatically
npm run dev

# Query local DB
npx wrangler d1 execute sagebridge-db --local --command="SELECT * FROM customers"
```

### View Logs
```bash
npm run tail
```

---

## 🔧 Configuration

### wrangler.toml
```toml
name = "sagebridge-api"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "sagebridge-db"
database_id = "YOUR_DB_ID"
```

### Environment Variables
Set in Cloudflare dashboard or via `wrangler secret`:
- `MASTER_API_KEY` - Admin API key

---

## 📝 Next Steps

1. ✅ **Test locally** - `npm run dev`
2. ✅ **Create D1 database** - `wrangler d1 create`
3. ✅ **Deploy** - `npm run deploy`
4. ⏳ **Update mobile app** - Point to your Workers URL
5. ⏳ **Update connector** - Set CloudflareWorkerUrl in config.json
6. ⏳ **Add custom domain** - api.yourdomain.com
7. ⏳ **Production auth** - Implement real API key hashing

---

## 🎯 Integration Points

### Mobile App (Next.js)
```typescript
const API_URL = 'https://api.sagebridge.workers.dev';
const API_KEY = 'demo-key';

fetch(`${API_URL}/api/customers`, {
  headers: { 'X-API-Key': API_KEY }
});
```

### Windows Connector (C#)
```csharp
_httpClient.BaseAddress = new Uri("https://api.sagebridge.workers.dev");
_httpClient.DefaultRequestHeaders.Add("X-API-Key", apiKey);

await _httpClient.PostAsync("/sync/customers", content);
```

---

## 🚨 Security Checklist

- [x] CORS configured
- [x] API key authentication
- [x] Tenant isolation in queries
- [ ] API key hashing (TODO for production)
- [ ] Rate limiting (TODO)
- [ ] Request validation (TODO)

---

**Built for SageBridge - Your Sage 50, Everywhere 🌉**

Deploy to Cloudflare's edge network and your API is live globally in seconds! 🚀
