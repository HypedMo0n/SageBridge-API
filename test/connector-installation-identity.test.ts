import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { handleRequest } from '../src/router.ts';
import { hashSecret } from '../src/security/security.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
const request=(path:string,body:unknown)=>new Request(`https://api.test${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const authRequest=(connectorId:string,credential:string)=>new Request('https://api.test/connector/jobs',{headers:{'X-Connector-Id':connectorId,'X-Connector-Credential':credential}});
const json=async(response:Response)=>({status:response.status,body:await response.json() as any});
async function database() {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'installation-identity-test'}});
  const db=(await mf.getBindings()).DB as D1Database;
  const sql=(file:string)=>readFileSync(join(root,file),'utf8').replace(/\r/g,'').split('\n').map(line=>line.replace(/--.*$/,'')).join(' ');
  for(const file of ['schema.sql','migrations/add-job-queue.sql','migrations/0002_job_idempotency_hardening.sql','migrations/0003_external_beta_phase1.sql','migrations/0004_pairing_claim_hardening.sql','migrations/0005_invoice_create.sql','migrations/0006_stable_installation_identity.sql']) await db.exec(sql(file));
  await db.exec(`INSERT INTO organizations(id,name) VALUES ('org_a','A'),('org_b','B'); INSERT INTO tenants(id,name) VALUES ('org_a','A'),('org_b','B'); INSERT INTO users(id,auth_provider,auth_subject) VALUES ('user','test','user'); INSERT INTO companies(id,organization_id,tenant_id,sage_company_name) VALUES ('cmp_a','org_a','org_a','A'),('cmp_a2','org_a','org_a','A2'),('cmp_b','org_b','org_b','B');`);
  return {mf,db,env:{DB:db} as any};
}
async function pairing(db:D1Database,org:string,company:string,code:string) {
  await db.prepare(`INSERT INTO pairing_codes(id,organization_id,company_id,created_by_user_id,code_hash,expires_at) VALUES (?,?,?,?,?,datetime('now','+10 minutes'))`).bind(`pair_${code}`,org,company,'user',await hashSecret(code)).run();
}
const exchange=async(env:any,code:string,installationId?:string,machineName='DESKTOP-A')=>json(await handleRequest(request('/connector/pairing/validate',{pairingCode:code,connectorVersion:'1.1.0',machineName,...(installationId?{installationId}:{})}),env));

test('stable installation identity reuses connector and rotates credentials',async()=>{
  const {mf,db,env}=await database();
  try {
    await pairing(db,'org_a','cmp_a','AAAA-AAAA');
    const first=await exchange(env,'AAAA-AAAA','inst_11111111-1111-4111-8111-111111111111');
    assert.equal(first.status,200);
    assert.equal((await db.prepare(`SELECT count(*) n FROM connectors WHERE organization_id='org_a'`).first<any>()).n,1);
    assert.equal((await db.prepare(`SELECT count(*) n FROM connector_credentials WHERE connector_id=? AND revoked_at IS NULL`).bind(first.body.connectorId).first<any>()).n,1);

    await pairing(db,'org_a','cmp_a','BBBB-BBBB');
    const second=await exchange(env,'BBBB-BBBB','inst_11111111-1111-4111-8111-111111111111','RENAMED');
    assert.equal(second.status,200,JSON.stringify(second.body)); assert.equal(second.body.connectorId,first.body.connectorId);
    assert.equal((await db.prepare(`SELECT count(*) n FROM connectors WHERE organization_id='org_a'`).first<any>()).n,1);
    assert.equal((await db.prepare(`SELECT count(*) n FROM connector_credentials WHERE connector_id=?`).bind(first.body.connectorId).first<any>()).n,2);
    assert.equal((await db.prepare(`SELECT count(*) n FROM connector_credentials WHERE connector_id=? AND revoked_at IS NULL`).bind(first.body.connectorId).first<any>()).n,1);
    assert.equal((await json(await handleRequest(authRequest(first.body.connectorId,first.body.credential),env))).status,401);
    assert.equal((await json(await handleRequest(authRequest(second.body.connectorId,second.body.credential),env))).status,200);

    await pairing(db,'org_a','cmp_a','CCCC-CCCC');
    const third=await exchange(env,'CCCC-CCCC','inst_11111111-1111-4111-8111-111111111111');
    assert.equal(third.body.connectorId,first.body.connectorId);
    assert.equal((await db.prepare(`SELECT count(*) n FROM connectors WHERE organization_id='org_a'`).first<any>()).n,1);
    assert.equal((await db.prepare(`SELECT count(*) n FROM connector_credentials WHERE connector_id=? AND revoked_at IS NULL`).bind(first.body.connectorId).first<any>()).n,1);
  } finally {await mf.dispose()}
});

test('same machine name with different installation IDs creates distinct identities',async()=>{
  const {mf,db,env}=await database();
  try {
    await pairing(db,'org_a','cmp_a','DDDD-DDDD'); const a=await exchange(env,'DDDD-DDDD','inst_22222222-2222-4222-8222-222222222222','SAME');
    await pairing(db,'org_a','cmp_a','EEEE-EEEE'); const b=await exchange(env,'EEEE-EEEE','inst_33333333-3333-4333-8333-333333333333','SAME');
    assert.equal(a.status,200); assert.equal(b.status,200); assert.notEqual(a.body.connectorId,b.body.connectorId);
  } finally {await mf.dispose()}
});

test('missing installation ID is rejected',async()=>{
  const {mf,db,env}=await database();
  try {await pairing(db,'org_a','cmp_a','FFFF-FFFF'); assert.equal((await exchange(env,'FFFF-FFFF')).status,400);}
  finally {await mf.dispose()}
});

test('installation binding conflicts do not mutate existing connector or credential',async()=>{
  const {mf,db,env}=await database();
  try {
    const installation='inst_44444444-4444-4444-8444-444444444444';
    await pairing(db,'org_a','cmp_a','GGGG-GGGG'); const first=await exchange(env,'GGGG-GGGG',installation);
    await pairing(db,'org_a','cmp_a2','HHHH-HHHH'); assert.equal((await exchange(env,'HHHH-HHHH',installation)).status,409);
    await pairing(db,'org_b','cmp_b','JJJJ-JJJJ'); assert.equal((await exchange(env,'JJJJ-JJJJ',installation)).status,409);
    assert.deepEqual(await db.prepare(`SELECT organization_id,company_id,machine_name FROM connectors WHERE id=?`).bind(first.body.connectorId).first<any>(),{organization_id:'org_a',company_id:'cmp_a',machine_name:'DESKTOP-A'});
    assert.equal((await db.prepare(`SELECT count(*) n FROM connector_credentials WHERE connector_id=? AND revoked_at IS NULL`).bind(first.body.connectorId).first<any>()).n,1);
  } finally {await mf.dispose()}
});

test('legacy NULL installation connector remains valid after uniqueness migration',async()=>{
  const {mf,db,env}=await database();
  try {
    await db.exec(`INSERT INTO connectors(id,organization_id,company_id,machine_name) VALUES ('legacy_1','org_a','cmp_a','LEGACY'),('legacy_2','org_a','cmp_a','LEGACY');`);
    await db.prepare(`INSERT INTO connector_credentials(id,connector_id,token_hash) VALUES ('legacy_cred','legacy_1',?)`).bind(await hashSecret('legacy-secret')).run();
    assert.equal((await json(await handleRequest(authRequest('legacy_1','legacy-secret'),env))).status,200);
    assert.equal((await db.prepare(`SELECT count(*) n FROM connectors WHERE installation_id IS NULL`).first<any>()).n,2);
  } finally {await mf.dispose()}
});
