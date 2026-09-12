import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { handleRequest } from '../src/router.ts';
import { hashSecret } from '../src/security/security.ts';

const root=new URL('..',import.meta.url).pathname;
const connectorId='conn_auth_test', credential='sbc_auth_test', tenantId='org_auth_test', companyId='cmp_auth_test';
const connectorRequest=(path:string,method='GET',body?:unknown,secret=credential)=>new Request(`https://api.test${path}`,{
  method,
  headers:{'X-Connector-Id':connectorId,'X-Connector-Credential':secret,...(body===undefined?{}:{'content-type':'application/json'})},
  body:body===undefined?undefined:JSON.stringify(body),
});

async function database() {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'connector-auth-write-test'}});
  const db=(await mf.getBindings()).DB as D1Database;
  const sql=(file:string)=>readFileSync(join(root,file),'utf8').split('\n').map(line=>line.replace(/--.*$/,'')).join(' ');
  await db.exec(sql('schema.sql'));
  await db.exec(sql('migrations/add-job-queue.sql'));
  await db.exec(sql('migrations/0002_job_idempotency_hardening.sql'));
  await db.exec(sql('migrations/0003_external_beta_phase1.sql'));
  await db.exec(sql('migrations/0004_pairing_claim_hardening.sql'));
  await db.prepare(`INSERT INTO organizations(id,name) VALUES (?,?)`).bind(tenantId,'Auth Test').run();
  await db.prepare(`INSERT INTO tenants(id,name) VALUES (?,?)`).bind(tenantId,'Auth Test').run();
  await db.prepare(`INSERT INTO companies(id,organization_id,tenant_id,sage_company_name) VALUES (?,?,?,?)`).bind(companyId,tenantId,tenantId,'Auth Test').run();
  await db.prepare(`INSERT INTO connectors(id,organization_id,company_id,machine_name,connector_version) VALUES (?,?,?,?,?)`).bind(connectorId,tenantId,companyId,'TEST','test').run();
  await db.prepare(`INSERT INTO connector_credentials(id,connector_id,token_hash) VALUES (?,?,?)`).bind('cred_auth_test',connectorId,await hashSecret(credential)).run();
  return {mf,db,env:{DB:db} as any};
}

async function lastUsed(db:D1Database) {
  return (await db.prepare(`SELECT last_used_at FROM connector_credentials WHERE id='cred_auth_test'`).first<any>())?.last_used_at??null;
}

test('empty authenticated job poll inside throttle window does not mutate last_used_at',async()=>{
  const {mf,db,env}=await database();
  try {
    const sentinel='2099-01-01 00:00:00';
    await db.prepare(`UPDATE connector_credentials SET last_used_at=? WHERE id='cred_auth_test'`).bind(sentinel).run();
    const response=await handleRequest(connectorRequest('/connector/jobs'),env);
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{jobs:[]});
    assert.equal(await lastUsed(db),sentinel);
  } finally {await mf.dispose()}
});

test('authenticated request refreshes last_used_at outside throttle window',async()=>{
  const {mf,db,env}=await database();
  try {
    await db.prepare(`UPDATE connector_credentials SET last_used_at='2000-01-01 00:00:00' WHERE id='cred_auth_test'`).run();
    assert.equal((await handleRequest(connectorRequest('/connector/jobs'),env)).status,200);
    assert.notEqual(await lastUsed(db),'2000-01-01 00:00:00');
  } finally {await mf.dispose()}
});

test('repeated authenticated requests inside throttle window do not refresh last_used_at',async()=>{
  const {mf,db,env}=await database();
  try {
    const sentinel='2099-01-01 00:00:00';
    await db.prepare(`UPDATE connector_credentials SET last_used_at=? WHERE id='cred_auth_test'`).bind(sentinel).run();
    assert.equal((await handleRequest(connectorRequest('/connector/jobs'),env)).status,200);
    assert.equal((await handleRequest(connectorRequest('/connector/jobs'),env)).status,200);
    assert.equal(await lastUsed(db),sentinel);
  } finally {await mf.dispose()}
});

test('invalid connector credential remains rejected',async()=>{
  const {mf,env}=await database();
  try { assert.equal((await handleRequest(connectorRequest('/connector/jobs','GET',undefined,'wrong'),env)).status,401); }
  finally {await mf.dispose()}
});

test('revoked and inactive connector credentials remain rejected',async()=>{
  const {mf,db,env}=await database();
  try {
    await db.prepare(`UPDATE connector_credentials SET revoked_at=CURRENT_TIMESTAMP WHERE id='cred_auth_test'`).run();
    assert.equal((await handleRequest(connectorRequest('/connector/jobs'),env)).status,401);
    await db.prepare(`UPDATE connector_credentials SET revoked_at=NULL WHERE id='cred_auth_test'`).run();
    await db.prepare(`UPDATE connectors SET status='revoked' WHERE id=?`).bind(connectorId).run();
    assert.equal((await handleRequest(connectorRequest('/connector/jobs'),env)).status,401);
  } finally {await mf.dispose()}
});

test('connector-authenticated write endpoint still authenticates',async()=>{
  const {mf,db,env}=await database();
  try {
    const sentinel='2099-01-01 00:00:00';
    await db.prepare(`UPDATE connector_credentials SET last_used_at=? WHERE id='cred_auth_test'`).bind(sentinel).run();
    const response=await handleRequest(connectorRequest('/connector/heartbeat','POST',{connectorVersion:'test',sageConnected:true}),env);
    assert.equal(response.status,200);
    assert.equal(await lastUsed(db),sentinel);
    assert.ok((await db.prepare(`SELECT last_seen_at FROM connectors WHERE id=?`).bind(connectorId).first<any>()).last_seen_at);
  } finally {await mf.dispose()}
});
