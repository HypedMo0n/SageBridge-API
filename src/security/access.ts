import type { Env } from '../index';
import { bearer, hashSecret, HttpError, requiredString } from './security';
import { verifyFirebaseJwt, type FirebaseClaims } from './firebase-jwt';

export interface UserContext { kind: 'user'; userId: string; claims: FirebaseClaims }
export interface ConnectorContext { kind: 'connector'; connectorId: string; organizationId: string; companyId: string }

export async function requireUser(request: Request, env: Env): Promise<UserContext> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, 'Firebase bearer token required', 'USER_TOKEN_REQUIRED');
  const claims = await verifyFirebaseJwt(token, env.FIREBASE_PROJECT_ID);
  if (claims.email_verified !== true) {
    throw new HttpError(403, 'Verified email required', 'EMAIL_NOT_VERIFIED');
  }
  const id = `usr_${(await hashSecret(`firebase:${claims.sub}`)).slice(0, 32)}`;
  await env.DB.prepare(`
    INSERT INTO users (id,auth_provider,auth_subject,email,display_name)
    VALUES (?,'firebase',?,?,?)
    ON CONFLICT(auth_provider,auth_subject) DO UPDATE SET
      email=excluded.email,
      display_name=COALESCE(excluded.display_name,users.display_name),
      updated_at=CURRENT_TIMESTAMP
  `).bind(id, claims.sub, claims.email ?? null, claims.name ?? null).run();
  return { kind: 'user', userId: id, claims };
}

export async function bootstrapUser(ctx: UserContext, env: Env) {
  let membership = await env.DB.prepare(`
    SELECT m.organization_id,o.name,m.role
    FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id
    WHERE m.user_id=? AND m.status='active' ORDER BY m.created_at LIMIT 1
  `).bind(ctx.userId).first<any>();
  if (!membership) {
    const org = `org_${crypto.randomUUID()}`;
    const company = `cmp_${crypto.randomUUID()}`;
    const name = ctx.claims.name || ctx.claims.email?.split('@')[0] || 'My organization';
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO organizations(id,name) VALUES (?,?)`).bind(org, name),
      env.DB.prepare(`INSERT INTO tenants(id,name,plan,status) VALUES (?,?,'beta','active')`).bind(org, name),
      env.DB.prepare(`INSERT INTO organization_memberships(organization_id,user_id,role,status) VALUES (?,?,'owner','active')`).bind(org, ctx.userId),
      env.DB.prepare(`INSERT INTO companies(id,organization_id,tenant_id,sage_company_name,connector_status) VALUES (?,?,?,?,'awaiting_connector')`).bind(company, org, org, 'My Sage company'),
      env.DB.prepare(`INSERT INTO provisioning(id,organization_id,company_id,state,progress) VALUES (?,?,?,'awaiting_connector',0)`).bind(`prv_${crypto.randomUUID()}`, org, company),
    ]);
    membership = { organization_id: org, name, role: 'owner' };
  }
  return membership;
}

export async function requireOrganizationMembership(userId: string, organizationId: string, env: Env, roles?: string[]) {
  const row = await env.DB.prepare(`SELECT role FROM organization_memberships WHERE user_id=? AND organization_id=? AND status='active'`).bind(userId, organizationId).first<any>();
  if (!row || (roles && !roles.includes(row.role))) throw new HttpError(403, 'Organization access denied', 'ORGANIZATION_DENIED');
  return row;
}

export async function requireCompanyAccess(userId: string, companyId: string, env: Env) {
  const row = await env.DB.prepare(`
    SELECT c.id,c.organization_id
    FROM companies c JOIN organization_memberships m ON m.organization_id=c.organization_id
    WHERE c.id=? AND m.user_id=? AND m.status='active'
  `).bind(companyId, userId).first<any>();
  if (!row) throw new HttpError(403, 'Company access denied', 'COMPANY_DENIED');
  return row;
}

export async function requireConnector(request: Request, env: Env): Promise<ConnectorContext> {
  const rawConnectorId=request.headers.get('x-connector-id'), rawCredential=request.headers.get('x-connector-credential');
  if(!rawConnectorId||!rawCredential) throw new HttpError(401,'Connector credentials required','CONNECTOR_CREDENTIALS_REQUIRED');
  const connectorId = requiredString(rawConnectorId,'X-Connector-Id',200);
  const credential = requiredString(rawCredential,'X-Connector-Credential',500);
  const hash = await hashSecret(credential);
  const row = await env.DB.prepare(`
    SELECT c.id connector_id,c.organization_id,c.company_id
    FROM connector_credentials k JOIN connectors c ON c.id=k.connector_id
    WHERE c.id=? AND k.token_hash=? AND k.revoked_at IS NULL
      AND (k.expires_at IS NULL OR k.expires_at>CURRENT_TIMESTAMP)
      AND c.revoked_at IS NULL AND c.status='active'
  `).bind(connectorId,hash).first<any>();
  if (!row) throw new HttpError(401, 'Invalid connector credential', 'INVALID_CONNECTOR_TOKEN');
  await env.DB.prepare(`UPDATE connector_credentials SET last_used_at=CURRENT_TIMESTAMP WHERE token_hash=?`).bind(hash).run();
  return { kind: 'connector', connectorId: row.connector_id, organizationId: row.organization_id, companyId: row.company_id };
}
