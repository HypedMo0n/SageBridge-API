import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { handleRequest } from '../src/router.ts';
import { hashSecret } from '../src/security/security.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
const credential='heartbeat-secret';
const heartbeat=(env:any,connectorId='conn_a',secret=credential,body:any={connectorVersion:'1.1.0',sageVersion:'2026',sageConnected:true})=>handleRequest(new Request('https://api.test/connector/heartbeat',{method:'POST',headers:{'content-type':'application/json','X-Connector-Id':connectorId,'X-Connector-Credential':secret},body:JSON.stringify(body)}),env);
async function database() {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'heartbeat-write-test'}});
  const db=(await mf.getBindings()).DB as D1Database;
  const sql=(file:string)=>readFileSync(join(root,file),'utf8').replace(/\r/g,'').split('\n').map(line=>line.replace(/--.*$/,'')).join(' ');
  for(const file of ['schema.sql','migrations/add-job-queue.sql','migrations/0002_job_idempotency_hardening.sql','migrations/0003_external_beta_phase1.sql','migrations/0004_pairing_claim_hardening.sql','migrations/0005_invoice_create.sql','migrations/0006_stable_installation_identity.sql']) await db.exec(sql(file));
  await db.exec(`INSERT INTO organizations(id,name) VALUES ('org_a','A'); INSERT INTO tenants(id,name) VALUES ('org_a','A'); INSERT INTO companies(id,organization_id,tenant_id,sage_company_name,connector_status) VALUES ('cmp_a','org_a','org_a','A','connected'); INSERT INTO connectors(id,organization_id,company_id,installation_id,machine_name) VALUES ('conn_a','org_a','cmp_a','inst_10000000-0000-4000-8000-000000000001','A'),('conn_b','org_a','cmp_a','inst_10000000-0000-4000-8000-000000000002','B');`);
  await db.prepare(`INSERT INTO connector_credentials(id,connector_id,token_hash,last_used_at) VALUES ('cred_a','conn_a',?,CURRENT_TIMESTAMP)`).bind(await hashSecret(credential)).run();
  return {mf,db,env:{DB:db} as any};
}
const connector=(db:D1Database,id='conn_a')=>db.prepare(`SELECT last_seen_at,updated_at,version,connector_version,sage_version,health_json FROM connectors WHERE id=?`).bind(id).first<any>();
const company=(db:D1Database)=>db.prepare(`SELECT last_seen_at,connector_status FROM companies WHERE id='cmp_a'`).first<any>();

test('first heartbeat updates connector and company presence only for authenticated connector',async()=>{
  const {mf,db,env}=await database();
  try {
    const beforeB=await connector(db,'conn_b');
    assert.equal((await heartbeat(env)).status,200);
    assert.ok((await connector(db)).last_seen_at); assert.ok((await company(db)).last_seen_at);
    assert.deepEqual(await connector(db,'conn_b'),beforeB);
  } finally {await mf.dispose()}
});

test('identical heartbeat inside presence window does not mutate timestamps',async()=>{
  const {mf,db,env}=await database();
  try {
    const sentinel='2099-01-01 00:00:00',health=JSON.stringify({version:'1.1.0',sageConnected:true});
    await db.prepare(`UPDATE connectors SET last_seen_at=?,updated_at=?,version='1.1.0',connector_version='1.1.0',sage_version='2026',health_json=? WHERE id='conn_a'`).bind(sentinel,sentinel,health).run();
    await db.prepare(`UPDATE companies SET last_seen_at=?,connector_status='connected' WHERE id='cmp_a'`).bind(sentinel).run();
    assert.equal((await heartbeat(env)).status,200);
    assert.equal((await connector(db)).last_seen_at,sentinel); assert.equal((await connector(db)).updated_at,sentinel); assert.equal((await company(db)).last_seen_at,sentinel);
  } finally {await mf.dispose()}
});

test('identical heartbeat after presence window refreshes timestamps',async()=>{
  const {mf,db,env}=await database();
  try {
    const old='2000-01-01 00:00:00',health=JSON.stringify({version:'1.1.0',sageConnected:true});
    await db.prepare(`UPDATE connectors SET last_seen_at=?,updated_at=?,version='1.1.0',connector_version='1.1.0',sage_version='2026',health_json=? WHERE id='conn_a'`).bind(old,old,health).run();
    await db.prepare(`UPDATE companies SET last_seen_at=?,connector_status='connected' WHERE id='cmp_a'`).bind(old).run();
    assert.equal((await heartbeat(env)).status,200);
    assert.notEqual((await connector(db)).last_seen_at,old); assert.notEqual((await company(db)).last_seen_at,old);
  } finally {await mf.dispose()}
});

test('health and version changes persist immediately inside presence window',async()=>{
  const {mf,db,env}=await database();
  try {
    const sentinel='2099-01-01 00:00:00';
    await db.prepare(`UPDATE connectors SET last_seen_at=?,updated_at=?,version='old',connector_version='old',sage_version='old',health_json='{}' WHERE id='conn_a'`).bind(sentinel,sentinel).run();
    assert.equal((await heartbeat(env)).status,200);
    const row=await connector(db);
    assert.equal(row.version,'1.1.0'); assert.equal(row.connector_version,'1.1.0'); assert.equal(row.sage_version,'2026'); assert.equal(row.health_json,JSON.stringify({version:'1.1.0',sageConnected:true}));
    assert.notEqual(row.last_seen_at,sentinel); assert.notEqual(row.updated_at,sentinel);
  } finally {await mf.dispose()}
});

test('company status change persists immediately inside presence window',async()=>{
  const {mf,db,env}=await database();
  try {
    const sentinel='2099-01-01 00:00:00';
    await db.prepare(`UPDATE companies SET last_seen_at=?,connector_status='offline' WHERE id='cmp_a'`).bind(sentinel).run();
    assert.equal((await heartbeat(env)).status,200);
    const row=await company(db); assert.equal(row.connector_status,'connected'); assert.notEqual(row.last_seen_at,sentinel);
  } finally {await mf.dispose()}
});

test('revoked connector and mismatched credential remain rejected',async()=>{
  const {mf,db,env}=await database();
  try {
    assert.equal((await heartbeat(env,'conn_b')).status,401);
    await db.prepare(`UPDATE connectors SET status='revoked',revoked_at=CURRENT_TIMESTAMP WHERE id='conn_a'`).run();
    assert.equal((await heartbeat(env)).status,401);
  } finally {await mf.dispose()}
});
