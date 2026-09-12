import type { Env } from '../index';
import { bootstrapUser, type ConnectorContext, requireCompanyAccess, requireOrganizationMembership, type UserContext } from '../security/access';
import { connectorIsStale, hashSecret, HttpError, isRecord, parseBoundedJson, randomSecret, requiredString, validatePairingCode } from '../security/security';
import { jsonResponse } from '../utils/response';

export const PROVISIONING_STATES = ['awaiting_connector','connector_connected','checking_sage','company_selected','provisioning','syncing_customers','syncing_invoices','syncing_products','syncing_quotes','finalizing','ready','failed'] as const;
type ProvisioningState = typeof PROVISIONING_STATES[number];
const NEXT: Record<ProvisioningState, readonly ProvisioningState[]> = {
  awaiting_connector: ['connector_connected','failed'], connector_connected: ['checking_sage','failed'],
  checking_sage: ['company_selected','failed'], company_selected: ['provisioning','failed'],
  provisioning: ['syncing_customers','failed'], syncing_customers: ['syncing_invoices','failed'],
  syncing_invoices: ['syncing_products','failed'], syncing_products: ['syncing_quotes','failed'],
  syncing_quotes: ['finalizing','failed'], finalizing: ['ready','failed'], ready: ['checking_sage','failed'],
  failed: ['checking_sage'],
};

const audit = (env: Env, actor: 'user'|'connector', actorId: string, action: string, org?: string, company?: string, outcome='success') =>
  env.DB.prepare(`INSERT INTO audit_events(organization_id,company_id,actor_type,actor_id,action,outcome) VALUES (?,?,?,?,?,?)`).bind(org ?? null, company ?? null, actor, actorId, action, outcome).run();

export async function rateLimit(env: Env, key: string, limit: number, windowSeconds: number) {
  const window = Math.floor(Date.now()/1000/windowSeconds);
  await env.DB.prepare(`INSERT INTO rate_limit_counters(bucket_key,window_start,count,expires_at) VALUES (?,?,1,datetime('now',?)) ON CONFLICT(bucket_key,window_start) DO UPDATE SET count=count+1`).bind(key, window, `+${windowSeconds*2} seconds`).run();
  const row = await env.DB.prepare(`SELECT count FROM rate_limit_counters WHERE bucket_key=? AND window_start=?`).bind(key, window).first<any>();
  if (Number(row?.count) > limit) throw new HttpError(429, 'Rate limit exceeded', 'RATE_LIMITED');
}

const companyDto = (row: any) => ({
  id: row.id, organizationId: row.organization_id, name: row.sage_company_name,
  connectorStatus: row.connector_status, lastSeenAt: row.last_seen_at ?? null,
  online: !connectorIsStale(row.last_seen_at), provisioningState: row.provisioning_state ?? null,
  provisioningProgress: row.provisioning_progress ?? null,
});

export async function handleBootstrap(user: UserContext, env: Env) {
  const membership = await bootstrapUser(user, env);
  const companies = (await env.DB.prepare(`SELECT c.*,p.state provisioning_state,p.progress provisioning_progress FROM companies c LEFT JOIN provisioning p ON p.company_id=c.id AND p.organization_id=c.organization_id WHERE c.organization_id=? ORDER BY c.created_at`).bind(membership.organization_id).all()).results;
  return jsonResponse({ user: { id:user.userId,email:user.claims.email??null,name:user.claims.name??null }, organization: { id:membership.organization_id,name:membership.name,role:membership.role }, companies:companies.map(companyDto) });
}

export async function handleMe(user: UserContext, env: Env) {
  const rows = (await env.DB.prepare(`SELECT o.id,o.name,m.role FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=? AND m.status='active'`).bind(user.userId).all()).results;
  return jsonResponse({ user:{id:user.userId,email:user.claims.email??null,name:user.claims.name??null}, organizations:rows.map((x:any)=>({id:x.id,name:x.name,role:x.role})) });
}
export const handleOrganizations = handleMe;

export async function handleCompanies(user: UserContext, org: string, env: Env) {
  await requireOrganizationMembership(user.userId, org, env);
  const rows=(await env.DB.prepare(`SELECT c.*,p.state provisioning_state,p.progress provisioning_progress FROM companies c LEFT JOIN provisioning p ON p.company_id=c.id AND p.organization_id=c.organization_id WHERE c.organization_id=? ORDER BY c.created_at`).bind(org).all()).results;
  return jsonResponse({companies:rows.map(companyDto)});
}

export async function createCompany(request: Request, user: UserContext, org: string, env: Env) {
  await requireOrganizationMembership(user.userId,org,env,['owner','admin']);
  const body=await parseBoundedJson(request,8192); if(!isRecord(body)) throw new HttpError(400,'Object required');
  const name=requiredString(body.name,'name',160), id=`cmp_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO companies(id,organization_id,tenant_id,sage_company_name,connector_status) VALUES (?,?,?,?, 'awaiting_connector')`).bind(id,org,org,name),
    env.DB.prepare(`INSERT INTO provisioning(id,organization_id,company_id,state,progress) VALUES (?,?,?,'awaiting_connector',0)`).bind(`prv_${crypto.randomUUID()}`,org,id),
  ]);
  await audit(env,'user',user.userId,'company.create',org,id);
  return jsonResponse({company:{id,organizationId:org,name,connectorStatus:'awaiting_connector'}},201);
}

export async function createPairing(request: Request, user: UserContext, company: string, env: Env) {
  const access=await requireCompanyAccess(user.userId,company,env);
  await requireOrganizationMembership(user.userId,access.organization_id,env,['owner','admin']);
  await rateLimit(env,`pair-create:${user.userId}`,10,3600);
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789', bytes=new Uint8Array(8); crypto.getRandomValues(bytes);
  const raw=[...bytes].map(x=>alphabet[x%alphabet.length]).join(''), code=`${raw.slice(0,4)}-${raw.slice(4)}`;
  const hash=await hashSecret(code), id=`pair_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE pairing_codes SET status='revoked' WHERE company_id=? AND organization_id=? AND status='active'`).bind(company,access.organization_id),
    env.DB.prepare(`INSERT INTO pairing_codes(id,organization_id,company_id,created_by_user_id,code_hash,expires_at) VALUES (?,?,?,?,?,datetime('now','+10 minutes'))`).bind(id,access.organization_id,company,user.userId,hash),
  ]);
  const expiresAt=(await env.DB.prepare(`SELECT expires_at FROM pairing_codes WHERE id=?`).bind(id).first<any>())!.expires_at;
  await audit(env,'user',user.userId,'pairing.create',access.organization_id,company);
  return jsonResponse({code,expiresAt,expiresInSeconds:600},201);
}

export async function exchangePairing(request: Request, env: Env, ip: string) {
  await rateLimit(env,`pair-exchange:${await hashSecret(ip)}`,20,600);
  const body=await parseBoundedJson(request,8192);
  const pairingCode=isRecord(body)?(body.pairingCode??body.code):undefined;
  if(!isRecord(body)||!validatePairingCode(pairingCode)) throw new HttpError(400,'Invalid pairing code format','INVALID_PAIRING_CODE');
  const machineName=requiredString(body.machineName??body.name,'machineName',160);
  const connectorVersion=requiredString(body.connectorVersion,'connectorVersion',50);
  const installation=requiredString(body.installationId,'installationId',200);
  if(!/^inst_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installation)) throw new HttpError(400,'Invalid installationId','INVALID_INSTALLATION_ID');
  const hash=await hashSecret(pairingCode);
  const row=await env.DB.prepare(`SELECT * FROM pairing_codes WHERE code_hash=?`).bind(hash).first<any>();
  if(!row) throw new HttpError(401,'Invalid pairing code','INVALID_PAIRING_CODE');
  if(row.status!=='active') throw new HttpError(409,'Pairing code already used or revoked','PAIRING_REPLAY');
  if(Date.parse(`${row.expires_at}Z`)<=Date.now()||row.attempts>=row.max_attempts){
    await env.DB.prepare(`UPDATE pairing_codes SET status='expired' WHERE id=? AND status='active'`).bind(row.id).run();
    throw new HttpError(410,'Pairing code expired','PAIRING_EXPIRED');
  }
  const existing=await env.DB.prepare(`SELECT id,organization_id,company_id FROM connectors WHERE installation_id=?`).bind(installation).first<any>();
  if(existing&&(existing.organization_id!==row.organization_id||existing.company_id!==row.company_id)) throw new HttpError(409,'Installation is already bound to another organization or company','INSTALLATION_BINDING_CONFLICT');
  const connector=existing?.id??`conn_${crypto.randomUUID()}`, credentialId=`cred_${crypto.randomUUID()}`, credential=`sbc_${randomSecret(48)}`;
  const credentialHash=await hashSecret(credential), pairedAt=new Date().toISOString();
  const connectorMutation=existing
    ? env.DB.prepare(`UPDATE connectors SET display_name=?,machine_name=?,version=?,connector_version=?,status='active',revoked_at=NULL,last_seen_at=?,paired_at=?,provisioning_state='connector_connected',updated_at=? WHERE id=? AND organization_id=? AND company_id=? AND installation_id=?`).bind(machineName,machineName,connectorVersion,connectorVersion,pairedAt,pairedAt,pairedAt,connector,row.organization_id,row.company_id,installation)
    : env.DB.prepare(`INSERT INTO connectors(id,organization_id,company_id,installation_id,display_name,machine_name,version,connector_version,last_seen_at,paired_at,provisioning_state) SELECT ?,organization_id,company_id,?,?,?,?,?,?,?,'connector_connected' FROM pairing_codes WHERE id=? AND claimed_connector_id=?`).bind(connector,installation,machineName,machineName,connectorVersion,connectorVersion,pairedAt,pairedAt,row.id,connector);
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE pairing_codes SET status='consumed',consumed_at=?,attempts=attempts+1,claimed_connector_id=? WHERE id=? AND status='active' AND expires_at>CURRENT_TIMESTAMP AND claimed_connector_id IS NULL`).bind(pairedAt,connector,row.id),
    connectorMutation,
    env.DB.prepare(`UPDATE connector_credentials SET revoked_at=? WHERE connector_id=? AND revoked_at IS NULL`).bind(pairedAt,connector),
    env.DB.prepare(`INSERT INTO connector_credentials(id,connector_id,token_hash) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM pairing_codes WHERE id=? AND claimed_connector_id=?)`).bind(credentialId,connector,credentialHash,row.id,connector),
    env.DB.prepare(`UPDATE companies SET connector_status='connected',last_seen_at=? WHERE id=? AND organization_id=? AND EXISTS(SELECT 1 FROM pairing_codes WHERE id=? AND claimed_connector_id=?)`).bind(pairedAt,row.company_id,row.organization_id,row.id,connector),
    env.DB.prepare(`UPDATE provisioning SET state='connector_connected',progress=10,error_code=NULL,error_message=NULL,updated_at=? WHERE company_id=? AND organization_id=? AND state='awaiting_connector' AND EXISTS(SELECT 1 FROM pairing_codes WHERE id=? AND claimed_connector_id=?)`).bind(pairedAt,row.company_id,row.organization_id,row.id,connector),
    env.DB.prepare(`INSERT INTO audit_events(organization_id,company_id,actor_type,actor_id,action,outcome) SELECT organization_id,company_id,'connector',?,'pairing.exchange','success' FROM pairing_codes WHERE id=? AND claimed_connector_id=?`).bind(connector,row.id,connector),
  ]);
  if((results[0].meta.changes??0)!==1) throw new HttpError(409,'Pairing code already used','PAIRING_REPLAY');
  return jsonResponse({connectorId:connector,credential,organizationId:row.organization_id,companyId:row.company_id,pairedAt});
}

export async function listConnectors(user: UserContext, company: string, env: Env) {
  const access=await requireCompanyAccess(user.userId,company,env);
  const rows=(await env.DB.prepare(`SELECT id,display_name,version,status,last_seen_at,created_at,revoked_at FROM connectors WHERE company_id=? AND organization_id=? ORDER BY created_at`).bind(company,access.organization_id).all()).results;
  return jsonResponse({connectors:rows.map((x:any)=>({id:x.id,displayName:x.display_name,version:x.version,status:x.status,lastSeenAt:x.last_seen_at,createdAt:x.created_at,revokedAt:x.revoked_at,online:x.status==='active'&&!connectorIsStale(x.last_seen_at)}))});
}

export async function heartbeat(request: Request,c: ConnectorContext,env: Env) {
  const body=await parseBoundedJson(request,8192);if(!isRecord(body))throw new HttpError(400,'Object required');
  const version=typeof body.connectorVersion==='string'?body.connectorVersion.slice(0,50):typeof body.version==='string'?body.version.slice(0,50):null;
  const sageVersion=typeof body.sageVersion==='string'?body.sageVersion.slice(0,50):null;
  const health=JSON.stringify({version,sageConnected:body.sageConnected===true});
  await env.DB.batch([
    env.DB.prepare(`UPDATE connectors SET last_seen_at=CURRENT_TIMESTAMP,version=?,connector_version=?,sage_version=?,health_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revoked_at IS NULL`).bind(version,version,sageVersion,health,c.connectorId),
    env.DB.prepare(`UPDATE companies SET last_seen_at=CURRENT_TIMESTAMP,connector_status='connected' WHERE id=? AND organization_id=?`).bind(c.companyId,c.organizationId),
  ]);
  return jsonResponse({ok:true,staleAfterSeconds:120});
}

export async function revokeConnector(user: UserContext,id: string,env: Env) {
  const c=await env.DB.prepare(`SELECT company_id,organization_id FROM connectors WHERE id=?`).bind(id).first<any>();
  if(!c)throw new HttpError(404,'Connector not found','CONNECTOR_NOT_FOUND');
  await requireOrganizationMembership(user.userId,c.organization_id,env,['owner','admin']);
  await env.DB.batch([
    env.DB.prepare(`UPDATE connectors SET revoked_at=CURRENT_TIMESTAMP,status='revoked',updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(id),
    env.DB.prepare(`UPDATE connector_credentials SET revoked_at=CURRENT_TIMESTAMP WHERE connector_id=?`).bind(id),
    env.DB.prepare(`UPDATE companies SET connector_status='awaiting_connector' WHERE id=? AND organization_id=? AND NOT EXISTS(SELECT 1 FROM connectors WHERE company_id=? AND organization_id=? AND status='active' AND revoked_at IS NULL)`).bind(c.company_id,c.organization_id,c.company_id,c.organization_id),
    env.DB.prepare(`UPDATE provisioning SET state='awaiting_connector',progress=0,updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND organization_id=? AND NOT EXISTS(SELECT 1 FROM connectors WHERE company_id=? AND organization_id=? AND status='active' AND revoked_at IS NULL)`).bind(c.company_id,c.organization_id,c.company_id,c.organization_id),
  ]);
  await audit(env,'user',user.userId,'connector.revoke',c.organization_id,c.company_id);
  return jsonResponse({revoked:true});
}

export async function provisioning(user: UserContext,company: string,env: Env) {
  const access=await requireCompanyAccess(user.userId,company,env);
  const p=await env.DB.prepare(`SELECT state,progress,error_code,error_message,updated_at FROM provisioning WHERE company_id=? AND organization_id=?`).bind(company,access.organization_id).first<any>();
  return p?jsonResponse({provisioning:{state:p.state,progress:p.progress,errorCode:p.error_code,errorMessage:p.error_message,updatedAt:p.updated_at}}):jsonResponse({error:'Not found',code:'PROVISIONING_NOT_FOUND'},404);
}

export async function startProvisioning(user: UserContext, company: string, env: Env) {
  const access=await requireCompanyAccess(user.userId,company,env);
  await requireOrganizationMembership(user.userId,access.organization_id,env,['owner','admin']);
  const connector=await env.DB.prepare(`SELECT id,last_seen_at FROM connectors WHERE company_id=? AND organization_id=? AND status='active' AND revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`).bind(company,access.organization_id).first<any>();
  if(!connector||connectorIsStale(connector.last_seen_at)) throw new HttpError(409,'An online connector is required','CONNECTOR_OFFLINE');
  const result=await env.DB.prepare(`UPDATE provisioning SET state='checking_sage',progress=15,error_code=NULL,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND organization_id=? AND state IN ('connector_connected','ready','failed')`).bind(company,access.organization_id).run();
  if((result.meta.changes??0)!==1) throw new HttpError(409,'Provisioning cannot start from its current state','INVALID_PROVISIONING_TRANSITION');
  await audit(env,'user',user.userId,'provisioning.start',access.organization_id,company);
  return jsonResponse({provisioning:{state:'checking_sage',progress:15}});
}

export async function updateProvisioning(request: Request,c: ConnectorContext,env: Env) {
  const body=await parseBoundedJson(request,8192);if(!isRecord(body))throw new HttpError(400,'Object required');
  const state=body.state;
  if(typeof state!=='string'||!PROVISIONING_STATES.includes(state as ProvisioningState)) throw new HttpError(400,'Invalid provisioning state','INVALID_PROVISIONING_STATE');
  const progress=body.progress;
  if(typeof progress!=='number'||!Number.isInteger(progress)||progress<0||progress>100) throw new HttpError(400,'progress must be an integer from 0 to 100','INVALID_PROGRESS');
  const current=await env.DB.prepare(`SELECT state,progress FROM provisioning WHERE company_id=? AND organization_id=?`).bind(c.companyId,c.organizationId).first<any>();
  if(!current) throw new HttpError(404,'Provisioning not found','PROVISIONING_NOT_FOUND');
  if(current.state!==state&&!NEXT[current.state as ProvisioningState]?.includes(state as ProvisioningState)) throw new HttpError(409,'Invalid provisioning transition','INVALID_PROVISIONING_TRANSITION');
  if(state!=='failed'&&progress<Number(current.progress)) throw new HttpError(409,'Provisioning progress cannot decrease','INVALID_PROGRESS');
  const errorCode=state==='failed'&&typeof body.errorCode==='string'?body.errorCode.slice(0,100):null;
  const errorMessage=state==='failed'&&typeof body.errorMessage==='string'?body.errorMessage.slice(0,1000):null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE provisioning SET state=?,progress=?,error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE company_id=? AND organization_id=?`).bind(state,progress,errorCode,errorMessage,c.companyId,c.organizationId),
    env.DB.prepare(`UPDATE connectors SET provisioning_state=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND company_id=? AND status='active'`).bind(state,c.connectorId,c.organizationId,c.companyId),
  ]);
  await audit(env,'connector',c.connectorId,'provisioning.progress',c.organizationId,c.companyId);
  return jsonResponse({provisioning:{state,progress,errorCode,errorMessage}});
}
