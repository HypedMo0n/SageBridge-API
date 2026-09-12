import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import {
  handleSyncCustomers,
  handleSyncInvoices,
  handleSyncProducts,
  handleSyncQuotes,
  handleSyncInvoiceSummary,
} from '../src/handlers/sync.ts';

const root = new URL('..', import.meta.url).pathname;
const tenantId = 'org_sync_test';
const companyId = 'cmp_sync_test';
const connectorId = 'conn_sync_test';
const marker = '2000-01-01 00:00:00';

const request = (body: unknown) => new Request('https://api.test/sync', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function database() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'sync-write-test' } });
  const db = (await mf.getBindings()).DB as D1Database;
  const sql = (file: string) => readFileSync(join(root, file), 'utf8').split('\n').map(line => line.replace(/--.*$/, '')).join(' ');
  await db.exec(sql('schema.sql'));
  await db.exec(sql('migrations/add-job-queue.sql'));
  await db.exec(sql('migrations/0002_job_idempotency_hardening.sql'));
  await db.exec(sql('migrations/0003_external_beta_phase1.sql'));
  await db.exec(sql('migrations/0004_pairing_claim_hardening.sql'));
  await db.prepare(`INSERT INTO organizations(id,name) VALUES (?,?)`).bind(tenantId, 'Sync Test').run();
  await db.prepare(`INSERT INTO tenants(id,name) VALUES (?,?)`).bind(tenantId, 'Sync Test').run();
  await db.prepare(`INSERT INTO companies(id,organization_id,tenant_id,sage_company_name) VALUES (?,?,?,?)`).bind(companyId, tenantId, tenantId, 'Sync Test').run();
  await db.prepare(`INSERT INTO connectors(id,organization_id,company_id,machine_name,connector_version) VALUES (?,?,?,?,?)`).bind(connectorId, tenantId, companyId, 'TEST', 'test').run();
  return { mf, db, env: { DB: db } as any };
}

async function syncCustomer(env: any, name = 'Acme') {
  return handleSyncCustomers(request({ Customers: [{ Id: 'C1', Name: name, Email: 'a@example.com', Phone: '555', Balance: 10, Status: 'Active' }] }), env, tenantId, companyId, connectorId);
}
async function syncInvoice(env: any, total = 100) {
  return handleSyncInvoices(request({ Invoices: [{ Id: 'I1', CustomerId: 'C1', InvoiceNumber: 'INV-1', Date: '2026-09-12', Total: total, Balance: total, Status: 'Unpaid' }] }), env, tenantId, companyId, connectorId);
}
async function syncProduct(env: any, price = 20) {
  return handleSyncProducts(request({ Products: [{ Id: 'P1', SKU: 'SKU-1', Name: 'Widget', Price: price, Stock: 5, ReorderLevel: 2, Category: 'Parts' }] }), env, tenantId, companyId, connectorId);
}
async function syncQuote(env: any, total = 30) {
  return handleSyncQuotes(request({ Quotes: [{ Id: 'Q1', QuoteNumber: 'QT-1', Total: total }] }), env, tenantId, companyId, connectorId);
}
async function syncSummary(env: any, outstanding = 40) {
  return handleSyncInvoiceSummary(request({ InvoiceSummary: { totalOutstanding: outstanding, overdueCount: 1 } }), env, tenantId, companyId, connectorId);
}

async function assertConditionalMutation(
  table: string,
  initial: (env: any) => Promise<Response>,
  changed: (env: any) => Promise<Response>,
  businessColumn: string,
  expectedChanged: unknown,
) {
  const { mf, db, env } = await database();
  try {
    assert.equal((await initial(env)).status, 200);
    await db.prepare(`UPDATE ${table} SET last_synced_at=? WHERE tenant_id=? AND company_id=?`).bind(marker, tenantId, companyId).run();
    assert.equal((await initial(env)).status, 200);
    const unchanged = await db.prepare(`SELECT last_synced_at,${businessColumn} business_value FROM ${table} WHERE tenant_id=? AND company_id=?`).bind(tenantId, companyId).first<any>();
    assert.equal(unchanged.last_synced_at, marker, `${table} identical sync must not update the row`);
    assert.equal((await changed(env)).status, 200);
    const updated = await db.prepare(`SELECT last_synced_at,${businessColumn} business_value FROM ${table} WHERE tenant_id=? AND company_id=?`).bind(tenantId, companyId).first<any>();
    assert.notEqual(updated.last_synced_at, marker, `${table} business change must update the row`);
    assert.deepEqual(updated.business_value, expectedChanged);
  } finally {
    await mf.dispose();
  }
}

test('customer upsert skips identical business data and persists a real change', async () => {
  await assertConditionalMutation('customers', env => syncCustomer(env), env => syncCustomer(env, 'Acme Updated'), 'name', 'Acme Updated');
});

test('invoice upsert skips identical business data and persists a real change', async () => {
  await assertConditionalMutation('invoices', env => syncInvoice(env), env => syncInvoice(env, 125), 'total', 125);
});

test('product upsert skips identical business data and persists a real change', async () => {
  await assertConditionalMutation('products', env => syncProduct(env), env => syncProduct(env, 25), 'price', 25);
});

test('quote upsert skips identical business data and persists a real change', async () => {
  await assertConditionalMutation('quotes', env => syncQuote(env), env => syncQuote(env, 35), 'payload_json', JSON.stringify({ Id: 'Q1', QuoteNumber: 'QT-1', Total: 35 }));
});

test('invoice summary skips identical JSON and persists a real change', async () => {
  await assertConditionalMutation('invoice_summaries', env => syncSummary(env), env => syncSummary(env, 45), 'payload_json', JSON.stringify({ totalOutstanding: 45, overdueCount: 1 }));
});

test('identical second full sync leaves every business row untouched', async () => {
  const { mf, db, env } = await database();
  try {
    const syncAll = () => Promise.all([syncCustomer(env), syncInvoice(env), syncProduct(env), syncQuote(env), syncSummary(env)]);
    for (const response of await syncAll()) assert.equal(response.status, 200);
    for (const table of ['customers', 'invoices', 'products', 'quotes', 'invoice_summaries']) {
      await db.prepare(`UPDATE ${table} SET last_synced_at=? WHERE tenant_id=? AND company_id=?`).bind(marker, tenantId, companyId).run();
    }
    for (const response of await syncAll()) assert.equal(response.status, 200);
    for (const table of ['customers', 'invoices', 'products', 'quotes', 'invoice_summaries']) {
      const row = await db.prepare(`SELECT last_synced_at FROM ${table} WHERE tenant_id=? AND company_id=?`).bind(tenantId, companyId).first<any>();
      assert.equal(row.last_synced_at, marker, `${table} was unnecessarily mutated`);
    }
  } finally {
    await mf.dispose();
  }
});
