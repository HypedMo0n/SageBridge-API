import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { handleRequest } from '../src/router.ts';
import worker from '../src/index.ts';

const root=new URL('..',import.meta.url).pathname;
const project='integration-project';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'}) as JsonWebKey;
const originalFetch=globalThis.fetch;
globalThis.fetch=(async (input:any,init?:any)=>String(input).includes('googleapis.com/service_accounts')
  ? new Response(JSON.stringify({integrationKid:jwk}),{headers:{'cache-control':'max-age=60'}})
  : originalFetch(input,init)) as typeof fetch;
const enc=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(sub:string,verified: boolean|null=true) {
  const now=Math.floor(Date.now()/1000), header=enc({alg:'RS256',kid:'integrationKid'});
  const claims:any={iss:`https://securetoken.google.com/${project}`,aud:project,sub,iat:now-1,exp:now+600,auth_time:now-2,email:`${sub}@example.com`,name:sub};
  if(verified!==null) claims.email_verified=verified;
  const payload=enc(claims), input=`${header}.${payload}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}
const auth=(token:string,extra:Record<string,string>={})=>({authorization:`Bearer ${token}`,...extra});
const request=(path:string,method='GET',token?:string,body?:unknown,extra:Record<string,string>={})=>new Request(`https://api.test${path}`,{method,headers:{...(token?auth(token):{}),...(body!==undefined?{'content-type':'application/json'}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
const connectorRequest=(path:string,method:string,connectorId:string,credential:string,body?:unknown,extra:Record<string,string>={})=>request(path,method,undefined,body,{'X-Connector-Id':connectorId,'X-Connector-Credential':credential,...extra});
const json=async(response:Response)=>({status:response.status,body:await response.json() as any});

async function database() {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'integration-db'}});
  const db=(await mf.getBindings()).DB as D1Database;
  const sql=(file:string)=>readFileSync(join(root,file),'utf8').split('\n').map(line=>line.replace(/--.*$/,'')).join(' ');
  await db.exec(sql('schema.sql'));
  await db.exec(sql('migrations/add-job-queue.sql'));
  await db.exec(sql('migrations/0002_job_idempotency_hardening.sql'));
  await db.exec(sql('migrations/0003_external_beta_phase1.sql'));
  await db.exec(sql('migrations/0004_pairing_claim_hardening.sql'));
  return {mf,env:{DB:db,FIREBASE_PROJECT_ID:project,FRONTEND_ORIGINS:'https://app.example.com'} as any};
}

test('migration upgrades legacy data under foreign keys and preserves references',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sagebridge-migration-')), db=join(dir,'test.sqlite');
  try {
    for(const file of ['schema.sql','migrations/add-job-queue.sql','migrations/0002_job_idempotency_hardening.sql']) execFileSync('sqlite3',[db],{input:readFileSync(join(root,file))});
    execFileSync('sqlite3',[db],{input:`PRAGMA foreign_keys=ON; INSERT INTO users(id,tenant_id,email,name) VALUES('legacy-user','demo-tenant','legacy@example.com','Legacy'); CREATE TABLE user_refs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id)); INSERT INTO user_refs VALUES('ref','legacy-user'); INSERT INTO connector_jobs(id,tenant_id,company_id,request_id,action,payload,status) VALUES('legacy-job','demo-tenant','demo-company','legacy-request','customer.create','{}','processing');`});
    execFileSync('sqlite3',[db],{input:readFileSync(join(root,'migrations/0003_external_beta_phase1.sql'))});
    assert.equal(execFileSync('sqlite3',[db,`SELECT auth_provider||':'||auth_subject FROM users WHERE id='legacy-user';`],{encoding:'utf8'}).trim(),'legacy:legacy-user');
    assert.equal(execFileSync('sqlite3',[db,`SELECT status FROM connector_jobs WHERE id='legacy-job';`],{encoding:'utf8'}).trim(),'running');
    assert.equal(execFileSync('sqlite3',[db,'PRAGMA foreign_key_check;'],{encoding:'utf8'}).trim(),'');
    assert.equal(execFileSync('sqlite3',[db,`SELECT user_id FROM user_refs WHERE id='ref';`],{encoding:'utf8'}).trim(),'legacy-user');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('unverified and missing-email-verification Firebase users cannot bootstrap',async()=>{
  const {mf,env}=await database();
  try {
    assert.deepEqual(await json(await handleRequest(request('/auth/bootstrap','POST',jwt('false-user',false)),env)),{status:403,body:{error:'Verified email required',code:'EMAIL_NOT_VERIFIED'}});
    assert.equal((await json(await handleRequest(request('/auth/bootstrap','POST',jwt('missing-user',null)),env))).status,403);
    assert.equal((await env.DB.prepare(`SELECT count(*) n FROM users WHERE auth_subject IN ('false-user','missing-user')`).first<any>()).n,0);
  } finally {await mf.dispose()}
});

test('routes enforce tenant isolation, pairing lifecycle, connector scope, provisioning and job replay',async()=>{
  const {mf,env}=await database();
  try {
    const tokenA=jwt('user-a'),tokenB=jwt('user-b');
    const bootA=await json(await handleRequest(request('/auth/bootstrap','POST',tokenA),env));
    const bootB=await json(await handleRequest(request('/auth/bootstrap','POST',tokenB),env));
    assert.equal(bootA.status,200); assert.equal(bootB.status,200);
    const companyA=bootA.body.companies[0].id, companyB=bootB.body.companies[0].id;
    assert.notEqual(companyA,companyB);
    assert.equal((await json(await handleRequest(request('/api/customers','GET',tokenA,undefined,{'x-company-id':companyB}),env))).status,403);
    assert.equal((await json(await handleRequest(request(`/api/companies/${companyB}/connectors`,'GET',tokenA),env))).status,403);

    const pairing=await json(await handleRequest(request(`/api/companies/${companyA}/pairing-codes`,'POST',tokenA,{}),env));
    assert.equal(pairing.status,201); assert.match(pairing.body.expiresAt,/\d{4}-\d{2}-\d{2}/);
    const attempts=await Promise.all([
      handleRequest(request('/connector/pairing/validate','POST',undefined,{pairingCode:pairing.body.code,connectorVersion:'0.1.0-beta',machineName:'DESKTOP-1234'}),env).then(json),
      handleRequest(request('/connector/pairing/validate','POST',undefined,{pairingCode:pairing.body.code,connectorVersion:'0.1.0-beta',machineName:'RACING-DESKTOP'}),env).then(json),
    ]);
    assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409]);
    const exchange=attempts.find(x=>x.status===200)!; const connectorToken=exchange.body.credential, connectorId=exchange.body.connectorId;
    assert.deepEqual(Object.keys(exchange.body).sort(),['companyId','connectorId','credential','organizationId','pairedAt']);
    assert.equal(exchange.body.companyId,companyA); assert.match(exchange.body.organizationId,/^org_/); assert.match(exchange.body.pairedAt,/T/);
    const storedConnector=await env.DB.prepare(`SELECT machine_name,connector_version,paired_at FROM connectors WHERE id=?`).bind(connectorId).first<any>();
    assert.ok(['DESKTOP-1234','RACING-DESKTOP'].includes(storedConnector.machine_name)); assert.equal(storedConnector.connector_version,'0.1.0-beta'); assert.ok(storedConnector.paired_at);
    assert.equal((await env.DB.prepare(`SELECT count(*) n FROM connector_credentials WHERE token_hash=?`).bind(connectorToken).first<any>()).n,0);
    assert.equal((await json(await handleRequest(request('/connector/pairing/validate','POST',undefined,{pairingCode:pairing.body.code,connectorVersion:'0.1.0-beta',machineName:'OTHER'}),env))).status,409);
    assert.equal((await json(await handleRequest(request('/connector/pairing/validate','POST',undefined,{pairingCode:'AAAA-AAAA',connectorVersion:'0.1.0-beta',machineName:'x'}),env))).status,401);
    const expiredPair=await json(await handleRequest(request(`/api/companies/${companyA}/pairing-codes`,'POST',tokenA,{}),env));
    await env.DB.prepare(`UPDATE pairing_codes SET expires_at=datetime('now','-1 minute') WHERE code_hash IS NOT NULL AND status='active'`).run();
    assert.equal((await json(await handleRequest(request('/connector/pairing/validate','POST',undefined,{pairingCode:expiredPair.body.code,connectorVersion:'0.1.0-beta',machineName:'expired'}),env))).status,410);

    const connectors=await json(await handleRequest(request(`/api/companies/${companyA}/connectors`,'GET',tokenA),env));
    assert.equal(connectors.body.connectors.length,1); assert.equal(connectors.body.connectors[0].id,connectorId);
    assert.equal((await json(await handleRequest(request('/connector/jobs'),env))).status,401);
    assert.equal((await json(await handleRequest(connectorRequest('/connector/jobs','GET',connectorId,'bad-token'),env))).status,401);
    assert.equal((await json(await handleRequest(connectorRequest('/connector/jobs','GET','conn_wrong',connectorToken),env))).status,401);
    await env.DB.prepare(`UPDATE connectors SET last_seen_at=datetime('now','-3 minutes') WHERE id=?`).bind(connectorId).run();
    assert.equal((await json(await handleRequest(request(`/api/companies/${companyA}/connectors`,'GET',tokenA),env))).body.connectors[0].online,false);
    assert.equal((await json(await handleRequest(request(`/api/companies/${companyA}/provisioning`,'POST',tokenA),env))).status,409);
    assert.equal((await json(await handleRequest(connectorRequest('/connector/heartbeat','POST',connectorId,connectorToken,{connectorVersion:'1.0',sageVersion:'2026',sageConnected:true}),env))).status,200);
    assert.equal((await json(await handleRequest(request(`/api/companies/${companyA}/provisioning`,'POST',tokenA),env))).body.provisioning.state,'checking_sage');
    assert.equal((await json(await handleRequest(connectorRequest('/connector/provisioning','POST',connectorId,connectorToken,{state:'company_selected',progress:25}),env))).status,200);
    assert.equal((await json(await handleRequest(request(`/api/companies/${companyA}/provisioning`,'GET',tokenA),env))).body.provisioning.state,'company_selected');
    assert.equal((await env.DB.prepare(`SELECT provisioning_state FROM connectors WHERE id=?`).bind(connectorId).first<any>()).provisioning_state,'company_selected');
    assert.equal((await json(await handleRequest(connectorRequest('/connector/provisioning','POST',connectorId,connectorToken,{state:'ready',progress:100}),env))).status,409);

    const customer=await json(await handleRequest(request('/api/customers','POST',tokenA,{idempotencyKey:'customer-1',customer:{name:'Acme'}},{'x-company-id':companyA}),env));
    const quote=await json(await handleRequest(request('/api/quotes','POST',tokenA,{idempotencyKey:'quote-1',quote:{customerId:'C1',lines:[{sku:'SKU',quantity:1,unitPrice:12}]}},{'x-company-id':companyA}),env));
    assert.equal(customer.status,201); assert.equal(quote.status,201);
    assert.equal((await json(await handleRequest(request('/api/customers','POST',tokenB,{idempotencyKey:'x',customer:{name:'No'}},{'x-company-id':companyA}),env))).status,403);
    assert.equal((await json(await handleRequest(request('/api/quotes','POST',tokenB,{idempotencyKey:'x',quote:{customerId:'C',lines:[{sku:'S',quantity:1,unitPrice:1}]}},{'x-company-id':companyA}),env))).status,403);
    const jobs=await json(await handleRequest(connectorRequest('/connector/jobs','GET',connectorId,connectorToken),env));
    assert.equal(jobs.body.jobs.length,2); assert.deepEqual(new Set(jobs.body.jobs.map((x:any)=>x.action)),new Set(['customer.create','quote.create']));
    const jobId=customer.body.jobId;
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/start`,'POST',connectorId,connectorToken),env))).body.status,'running');
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/start`,'POST',connectorId,connectorToken),env))).status,409);
    await env.DB.prepare(`UPDATE connector_jobs SET claim_expires_at=datetime('now','-1 second') WHERE id=?`).bind(jobId).run();
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/result`,'POST',connectorId,connectorToken,{status:'succeeded',sageId:'stale'}),env))).status,409);

    const replacementPair=await json(await handleRequest(request(`/api/companies/${companyA}/pairing-codes`,'POST',tokenA,{}),env));
    await env.DB.prepare(`UPDATE provisioning SET state='ready',progress=100 WHERE company_id=?`).bind(companyA).run();
    const replacement=await json(await handleRequest(request('/connector/pairing/validate','POST',undefined,{pairingCode:replacementPair.body.code,connectorVersion:'0.1.0-beta',machineName:'DESKTOP-A2'}),env));
    assert.deepEqual(await env.DB.prepare(`SELECT state,progress FROM provisioning WHERE company_id=?`).bind(companyA).first<any>(),{state:'ready',progress:100});
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/start`,'POST',replacement.body.connectorId,replacement.body.credential),env))).status,200);
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/result`,'POST',connectorId,connectorToken,{status:'succeeded',sageId:'stale'}),env))).status,403);

    const pairingB=await json(await handleRequest(request(`/api/companies/${companyB}/pairing-codes`,'POST',tokenB,{}),env));
    const exchangeB=await json(await handleRequest(request('/connector/pairing/validate','POST',undefined,{pairingCode:pairingB.body.code,connectorVersion:'0.1.0-beta',machineName:'DESKTOP-B'}),env));
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/result`,'POST',exchangeB.body.connectorId,exchangeB.body.credential,{status:'succeeded',sageId:'bad'}),env))).status,404);
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/result`,'POST',replacement.body.connectorId,replacement.body.credential,{status:'succeeded'}),env))).status,400);
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/result`,'POST',replacement.body.connectorId,replacement.body.credential,{status:'failed'}),env))).status,400);
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/result`,'POST',replacement.body.connectorId,replacement.body.credential,{status:'succeeded',sageId:'C100'}),env))).status,200);
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/result`,'POST',replacement.body.connectorId,replacement.body.credential,{status:'succeeded',sageId:'C100'}),env))).body.existing,true);
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/result`,'POST',replacement.body.connectorId,replacement.body.credential,{status:'succeeded',sageId:'C999'}),env))).status,409);
    assert.equal((await json(await handleRequest(request(`/api/jobs/${jobId}`,'GET',tokenA,undefined,{'x-company-id':companyA}),env))).body.status,'succeeded');

    assert.equal((await json(await handleRequest(connectorRequest('/sync/invoices','POST',connectorId,connectorToken,{Invoices:[{InvoiceNumber:'bad'}]}),env))).status,400);
    assert.equal((await json(await handleRequest(connectorRequest('/sync/products','POST',connectorId,connectorToken,{Products:[{Name:'bad'}]}),env))).status,400);
    assert.equal((await json(await handleRequest(connectorRequest('/sync/quotes','POST',connectorId,connectorToken,{Quotes:[{Name:'bad'}]}),env))).status,400);
    for (const [path,body] of [
      ['/sync/customers',{Customers:[]}], ['/sync/invoices',{Invoices:[]}], ['/sync/products',{Products:[]}],
      ['/sync/quotes',{Quotes:[]}], ['/sync/invoice-summary',{InvoiceSummary:{totalOutstanding:10,overdueCount:1}}]
    ] as const) {
      assert.equal((await json(await handleRequest(connectorRequest(path,'POST',connectorId,connectorToken,body),env))).status,200,path);
    }
    assert.equal((await json(await handleRequest(connectorRequest('/sync/customers','POST',connectorId,connectorToken,{companyId:companyB,Customers:[]}),env))).status,409);
    const syncScope=await env.DB.prepare(`SELECT tenant_id,company_id FROM sync_events WHERE entity_type='quotes' ORDER BY id DESC LIMIT 1`).first<any>();
    assert.equal(syncScope.tenant_id,exchange.body.organizationId); assert.equal(syncScope.company_id,companyA);
    assert.ok((await env.DB.prepare(`SELECT last_sync_at FROM connectors WHERE id=?`).bind(connectorId).first<any>()).last_sync_at);
    assert.equal((await env.DB.prepare(`SELECT last_sync_at FROM connectors WHERE id=?`).bind(replacement.body.connectorId).first<any>()).last_sync_at,null);

    assert.equal((await json(await handleRequest(request(`/connectors/${connectorId}/revoke`,'POST',tokenA),env))).status,200);
    assert.equal((await json(await handleRequest(connectorRequest('/connector/heartbeat','POST',connectorId,connectorToken,{}),env))).status,401);
    assert.equal((await env.DB.prepare(`SELECT connector_status FROM companies WHERE id=?`).bind(companyA).first<any>()).connector_status,'connected');
    assert.equal((await env.DB.prepare(`SELECT state FROM provisioning WHERE company_id=?`).bind(companyA).first<any>()).state,'ready');
    assert.equal((await json(await handleRequest(request(`/connectors/${replacement.body.connectorId}/revoke`,'POST',tokenA),env))).status,200);
    assert.equal((await env.DB.prepare(`SELECT connector_status FROM companies WHERE id=?`).bind(companyA).first<any>()).connector_status,'awaiting_connector');
  } finally {await mf.dispose()}
});

test('expired claims are reclaimable and jobs that exhaust max_attempts fail terminally',async()=>{
  const {mf,env}=await database();
  try {
    const token=jwt('retry-user');
    const boot=await json(await handleRequest(request('/auth/bootstrap','POST',token),env));
    const company=boot.body.companies[0].id;
    const pairing=await json(await handleRequest(request(`/api/companies/${company}/pairing-codes`,'POST',token,{}),env));
    const exchange=await json(await handleRequest(request('/connector/pairing/validate','POST',undefined,{pairingCode:pairing.body.code,connectorVersion:'0.1.0-beta',machineName:'RETRY-DESKTOP'}),env));
    const connectorId=exchange.body.connectorId, credential=exchange.body.credential;

    const customer=await json(await handleRequest(request('/api/customers','POST',token,{idempotencyKey:'retry-1',customer:{name:'Retry Co'}},{'x-company-id':company}),env));
    const jobId=customer.body.jobId;

    // Claim once, then let the claim expire without a result: the job must stay reclaimable.
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/start`,'POST',connectorId,credential),env))).status,200);
    await env.DB.prepare(`UPDATE connector_jobs SET claim_expires_at=datetime('now','-1 second') WHERE id=?`).bind(jobId).run();
    const listed=await json(await handleRequest(connectorRequest('/connector/jobs','GET',connectorId,credential),env));
    assert.ok(listed.body.jobs.some((j:any)=>j.jobId===jobId));
    assert.equal((await json(await handleRequest(connectorRequest(`/connector/jobs/${jobId}/start`,'POST',connectorId,credential),env))).status,200);
    assert.equal((await env.DB.prepare(`SELECT attempts,status FROM connector_jobs WHERE id=?`).bind(jobId).first<any>()).attempts,2);

    // Once attempts reach max_attempts (5) with an expired claim and no result, the job
    // must stop being handed out and must resolve to a terminal 'failed' state rather
    // than staying stuck in 'running' forever.
    await env.DB.prepare(`UPDATE connector_jobs SET attempts=5,claim_expires_at=datetime('now','-1 second') WHERE id=?`).bind(jobId).run();
    const afterExhausted=await json(await handleRequest(connectorRequest('/connector/jobs','GET',connectorId,credential),env));
    assert.ok(!afterExhausted.body.jobs.some((j:any)=>j.jobId===jobId));
    const finalStatus=await json(await handleRequest(request(`/api/jobs/${jobId}`,'GET',token,undefined,{'x-company-id':company}),env));
    assert.equal(finalStatus.body.status,'failed');
    assert.equal(finalStatus.body.error,'Exceeded max retry attempts');
  } finally {await mf.dispose()}
});

test('CORS reflects configured origins only and rejects disallowed preflight',async()=>{
  const {mf,env}=await database();
  try {
    const ctx={waitUntil(){},passThroughOnException(){}} as any;
    const allowed=await worker.fetch(request('/health','GET',undefined,undefined,{origin:'https://app.example.com'}),env,ctx);
    assert.equal(allowed.headers.get('access-control-allow-origin'),'https://app.example.com');
    const denied=await worker.fetch(request('/health','OPTIONS',undefined,undefined,{origin:'https://evil.example'}),env,ctx);
    assert.equal(denied.status,403); assert.equal(denied.headers.get('access-control-allow-origin'),null);
  } finally {await mf.dispose()}
});
