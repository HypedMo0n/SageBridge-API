/**
 * Authentication and company-scope middleware.
 *
 * A connector credential identifies a tenant, never a mutable "current"
 * company. Every connector request must name X-Company-Id and that company is
 * checked against the connector tenant before any handler runs.
 */

import { Env } from '../index';
import { validateCompanySelection } from '../security/company-scope';

export interface AuthResult {
  authenticated: boolean;
  tenantId?: string;
  companyId?: string;
  principal?: 'user' | 'connector';
  connectorId?: string;
  status?: number;
  error?: string;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function selectCompany(env: Env, tenantId: string, requestedCompanyId: string | null) {
  const company = requestedCompanyId
    ? await env.DB.prepare(`
        SELECT id, tenant_id
        FROM companies
        WHERE id = ? AND tenant_id = ?
      `).bind(requestedCompanyId, tenantId).first<{ id: string; tenant_id: string }>()
    : null;

  return validateCompanySelection(
    tenantId,
    requestedCompanyId,
    company ? { id: company.id, tenantId: company.tenant_id } : null
  );
}

async function authenticateConnector(request: Request, env: Env): Promise<AuthResult | null> {
  const connectorId = request.headers.get('X-Connector-Id');
  const credential = request.headers.get('X-Connector-Credential');
  if (!connectorId && !credential) return null;

  if (!connectorId || !credential) {
    return { authenticated: false, status: 401, error: 'Incomplete connector credentials' };
  }

  const credentialHash = await sha256Hex(credential);
  const connector = await env.DB.prepare(`
    SELECT tenant_id, status
    FROM connectors
    WHERE id = ? AND credential_hash = ?
  `).bind(connectorId, credentialHash).first<{ tenant_id: string; status: string }>();

  if (!connector || connector.status !== 'active') {
    return { authenticated: false, status: 401, error: 'Invalid or revoked connector credential' };
  }

  const selection = await selectCompany(env, connector.tenant_id, request.headers.get('X-Company-Id'));
  if (!selection.ok) {
    return { authenticated: false, status: selection.status, error: selection.error };
  }

  return {
    authenticated: true,
    tenantId: connector.tenant_id,
    companyId: selection.companyId,
    connectorId,
    principal: 'connector'
  };
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const connectorResult = await authenticateConnector(request, env);
  if (connectorResult) return connectorResult;

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) {
    return { authenticated: false, status: 401, error: 'Missing API key. Include X-API-Key header.' };
  }

  let tenantId: string;
  let defaultCompanyId: string;
  if (apiKey === 'demo-key') {
    tenantId = 'demo-tenant';
    defaultCompanyId = 'demo-company';
  } else {
    // Legacy beta user authentication. Connector endpoints never accept this
    // credential path; per-connector machine credentials are mandatory there.
    const parts = apiKey.split('_');
    if (parts.length < 2) {
      return { authenticated: false, status: 401, error: 'Invalid API key' };
    }
    tenantId = parts[0];
    defaultCompanyId = parts[1];
  }

  const requestedCompanyId = request.headers.get('X-Company-Id') || defaultCompanyId;
  const selection = await selectCompany(env, tenantId, requestedCompanyId);
  if (!selection.ok) {
    return { authenticated: false, status: selection.status, error: selection.error };
  }

  return {
    authenticated: true,
    tenantId,
    companyId: selection.companyId,
    principal: 'user'
  };
}
