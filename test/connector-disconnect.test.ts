// Behavioral proof of the SageBridge "Disconnect Sage 50" acceptance
// criteria: revoking a connector via the real HTTP handler must reject its
// credential everywhere it's used (heartbeat, sync, job claiming), leave
// existing Sage records untouched, record an audit event, and surface as
// "not connected" to the frontend's connector list - and re-pairing the
// same installation afterward must issue a fresh credential while the old
// one stays invalid forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { handleRequest } from '../src/router.ts';

const root = new URL('..', import.meta.url).pathname;
const project = 'disconnect-project';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => String(input).includes('googleapis.com/service_accounts')
  ? new Response(JSON.stringify({ disconnectKid: jwk }), { headers: { 'cache-control': 'max-age=60' } })
  : originalFetch(input, init)) as typeof fetch;

const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(sub: string) {
  const now = Math.floor(Date.now() / 1000), header = enc({ alg: 'RS256', kid: 'disconnectKid' });
  const claims: any = { iss: `https://securetoken.google.com/${project}`, aud: project, sub, iat: now - 1, exp: now + 600, auth_time: now - 2, email: `${sub}@example.com`, name: sub, email_verified: true };
  const input = `${header}.${enc(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}
const request = (path: string, method = 'GET', token?: string, body?: unknown, extra: Record<string, string> = {}) => new Request(`https://api.test${path}`, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const connectorRequest = (path: string, method: string, connectorId: string, credential: string, body?: unknown) =>
  request(path, method, undefined, body, { 'X-Connector-Id': connectorId, 'X-Connector-Credential': credential });
const json = async (response: Response) => ({ status: response.status, body: await response.json() as any });

async function database() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'disconnect-db' } });
  const db = (await mf.getBindings()).DB as D1Database;
  const sql = (file: string) => readFileSync(join(root, file), 'utf8').replace(/\r/g, '').split('\n').map((line) => line.replace(/--.*$/, '')).join(' ');
  for (const file of ['schema.sql', 'migrations/add-job-queue.sql', 'migrations/0002_job_idempotency_hardening.sql', 'migrations/0003_external_beta_phase1.sql', 'migrations/0004_pairing_claim_hardening.sql', 'migrations/0005_invoice_create.sql', 'migrations/0006_stable_installation_identity.sql']) {
    await db.exec(sql(file));
  }
  return { mf, db, env: { DB: db, FIREBASE_PROJECT_ID: project, FRONTEND_ORIGINS: 'https://app.example.com' } as any };
}

test('disconnecting a connector rejects its credential everywhere, preserves data, and audits the action', async () => {
  const { mf, db, env } = await database();
  try {
    const token = jwt('owner-user');
    const boot = await json(await handleRequest(request('/auth/bootstrap', 'POST', token), env));
    const companyId = boot.body.companies[0].id;

    // Pair a connector for real, through the same exchange the Windows
    // connector uses - not a hand-inserted row.
    const pairing = await json(await handleRequest(request(`/api/companies/${companyId}/pairing-codes`, 'POST', token, {}), env));
    const exchange = await json(await handleRequest(request('/connector/pairing/validate', 'POST', undefined, {
      pairingCode: pairing.body.code, connectorVersion: '1.1.0', machineName: 'OFFICE-PC',
      installationId: 'inst_00000000-0000-4000-8000-0000000000aa',
    }), env));
    assert.equal(exchange.status, 200);
    const { connectorId, credential } = exchange.body;

    // Seed existing Sage data via the same sync path the connector uses -
    // this is exactly the data that must survive disconnection untouched.
    assert.equal((await json(await handleRequest(connectorRequest('/sync/customers', 'POST', connectorId, credential, {
      Customers: [{ Id: 'CUST-1', Name: 'Universal Construction', Email: 'billing@universal.example', Balance: 4200, Status: 'Active' }],
    }), env))).status, 200);
    assert.equal((await json(await handleRequest(connectorRequest('/sync/invoices', 'POST', connectorId, credential, {
      Invoices: [{ Id: 'INV-1', InvoiceNumber: 'INV-1001', Date: '2026-09-01', CustomerId: 'CUST-1', Total: 4200, Balance: 4200, Status: 'Unpaid' }],
    }), env))).status, 200);
    assert.equal((await json(await handleRequest(connectorRequest('/sync/products', 'POST', connectorId, credential, {
      Products: [{ Id: 'PROD-1', SKU: 'SKU-1', Name: 'Widget', Price: 10 }],
    }), env))).status, 200);
    const customerSnapshot = await db.prepare(`SELECT name, balance FROM customers WHERE sage_id='CUST-1'`).first<any>();
    const invoiceSnapshot = await db.prepare(`SELECT invoice_number, balance FROM invoices WHERE sage_id='INV-1'`).first<any>();

    // Sanity: everything works pre-disconnect.
    assert.equal((await json(await handleRequest(connectorRequest('/connector/heartbeat', 'POST', connectorId, credential, { connectorVersion: '1.1.0', sageConnected: true }), env))).status, 200);
    assert.equal((await json(await handleRequest(connectorRequest('/connector/jobs', 'GET', connectorId, credential), env))).status, 200);
    const connectorsBefore = await json(await handleRequest(request(`/api/companies/${companyId}/connectors`, 'GET', token), env));
    assert.equal(connectorsBefore.body.connectors[0].status, 'active');
    assert.equal(connectorsBefore.body.connectors[0].machineName, 'OFFICE-PC');

    // --- Disconnect, via the real endpoint the Settings UI calls ---
    const disconnect = await json(await handleRequest(request(`/api/connectors/${connectorId}/revoke`, 'POST', token), env));
    assert.equal(disconnect.status, 200);
    assert.deepEqual(disconnect.body, { revoked: true });

    // Old credential must immediately fail authentication everywhere it's used.
    assert.equal((await json(await handleRequest(connectorRequest('/connector/heartbeat', 'POST', connectorId, credential, { connectorVersion: '1.1.0', sageConnected: true }), env))).status, 401, 'heartbeat must reject after disconnect');
    assert.equal((await json(await handleRequest(connectorRequest('/sync/customers', 'POST', connectorId, credential, { Customers: [] }), env))).status, 401, 'sync must reject after disconnect');
    assert.equal((await json(await handleRequest(connectorRequest('/connector/jobs', 'GET', connectorId, credential), env))).status, 401, 'job listing must reject after disconnect');
    assert.equal((await json(await handleRequest(connectorRequest('/connector/provisioning', 'POST', connectorId, credential, { state: 'ready', progress: 100 }), env))).status, 401, 'provisioning reports must reject after disconnect');

    // Existing Sage records are untouched - disconnect is not a data wipe.
    const customerAfter = await db.prepare(`SELECT name, balance FROM customers WHERE sage_id='CUST-1'`).first<any>();
    const invoiceAfter = await db.prepare(`SELECT invoice_number, balance FROM invoices WHERE sage_id='INV-1'`).first<any>();
    assert.deepEqual(customerAfter, customerSnapshot);
    assert.deepEqual(invoiceAfter, invoiceSnapshot);
    assert.equal((await db.prepare(`SELECT count(*) n FROM products WHERE sage_id='PROD-1'`).first<any>()).n, 1);

    // The credential itself is revoked at rest, not merely orphaned.
    const credentialRow = await db.prepare(`SELECT revoked_at FROM connector_credentials WHERE connector_id=?`).bind(connectorId).first<any>();
    assert.ok(credentialRow.revoked_at, 'the credential row must carry its own revoked_at, not rely solely on the connector row');

    // Audit history is preserved and attributable.
    const auditRow = await db.prepare(`SELECT actor_type, actor_id, outcome, organization_id, company_id FROM audit_events WHERE action='connector.revoke' ORDER BY id DESC LIMIT 1`).first<any>();
    assert.equal(auditRow.actor_type, 'user');
    assert.equal(auditRow.outcome, 'success');
    assert.equal(auditRow.company_id, companyId);

    // The frontend's connector list must now show it as not connected.
    const connectorsAfter = await json(await handleRequest(request(`/api/companies/${companyId}/connectors`, 'GET', token), env));
    assert.equal(connectorsAfter.body.connectors[0].status, 'revoked');
    assert.equal(connectorsAfter.body.connectors[0].online, false);

    // --- Re-pairing the same installation must issue a brand-new credential ---
    const pairing2 = await json(await handleRequest(request(`/api/companies/${companyId}/pairing-codes`, 'POST', token, {}), env));
    const reExchange = await json(await handleRequest(request('/connector/pairing/validate', 'POST', undefined, {
      pairingCode: pairing2.body.code, connectorVersion: '1.1.0', machineName: 'OFFICE-PC',
      installationId: 'inst_00000000-0000-4000-8000-0000000000aa',
    }), env));
    assert.equal(reExchange.status, 200);
    assert.equal(reExchange.body.connectorId, connectorId, 'the stable installation reuses the same connector identity');
    assert.notEqual(reExchange.body.credential, credential, 're-pairing must issue a genuinely new credential');

    // The OLD credential remains invalid forever - it does not come back to life.
    assert.equal((await json(await handleRequest(connectorRequest('/connector/heartbeat', 'POST', connectorId, credential, { connectorVersion: '1.1.0', sageConnected: true }), env))).status, 401, 'the old credential must never become valid again');

    // The NEW credential works, and the connector reports online again.
    assert.equal((await json(await handleRequest(connectorRequest('/connector/heartbeat', 'POST', connectorId, reExchange.body.credential, { connectorVersion: '1.1.0', sageConnected: true }), env))).status, 200);
    const connectorsFinal = await json(await handleRequest(request(`/api/companies/${companyId}/connectors`, 'GET', token), env));
    assert.equal(connectorsFinal.body.connectors[0].status, 'active');
    assert.equal(connectorsFinal.body.connectors[0].online, true);
  } finally {
    await mf.dispose();
  }
});

test('a user outside the organization cannot disconnect another organization\'s connector', async () => {
  const { mf, env } = await database();
  try {
    const tokenA = jwt('owner-a'), tokenB = jwt('outsider-b');
    const bootA = await json(await handleRequest(request('/auth/bootstrap', 'POST', tokenA), env));
    await json(await handleRequest(request('/auth/bootstrap', 'POST', tokenB), env));
    const companyA = bootA.body.companies[0].id;
    const pairing = await json(await handleRequest(request(`/api/companies/${companyA}/pairing-codes`, 'POST', tokenA, {}), env));
    const exchange = await json(await handleRequest(request('/connector/pairing/validate', 'POST', undefined, {
      pairingCode: pairing.body.code, connectorVersion: '1.1.0', machineName: 'OFFICE-PC',
      installationId: 'inst_00000000-0000-4000-8000-0000000000bb',
    }), env));

    const forbidden = await json(await handleRequest(request(`/api/connectors/${exchange.body.connectorId}/revoke`, 'POST', tokenB), env));
    assert.equal(forbidden.status, 403);

    // Still fully functional - the rejected attempt must not have mutated anything.
    assert.equal((await json(await handleRequest(connectorRequest('/connector/heartbeat', 'POST', exchange.body.connectorId, exchange.body.credential, { connectorVersion: '1.1.0', sageConnected: true }), env))).status, 200);
  } finally {
    await mf.dispose();
  }
});
