/**
 * Authentication middleware
 */

import { Env } from '../index';

export interface AuthResult {
  authenticated: boolean;
  tenantId?: string;
  companyId?: string;
  error?: string;
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  // Get API key from header
  const apiKey = request.headers.get('X-API-Key');
  
  if (!apiKey) {
    return {
      authenticated: false,
      error: 'Missing API key. Include X-API-Key header.'
    };
  }

  // For demo purposes, accept the demo API key
  if (apiKey === 'demo-key') {
    return {
      authenticated: true,
      tenantId: 'demo-tenant',
      companyId: 'demo-company'
    };
  }

  // TODO: In production, lookup API key in database
  // const result = await env.DB.prepare(
  //   'SELECT tenant_id, company_id FROM api_keys WHERE key_hash = ?'
  // ).bind(hashApiKey(apiKey)).first();

  // For now, extract tenant/company from key format: tenant_company_randomstring
  const parts = apiKey.split('_');
  if (parts.length >= 2) {
    return {
      authenticated: true,
      tenantId: parts[0],
      companyId: parts[1]
    };
  }

  return {
    authenticated: false,
    error: 'Invalid API key'
  };
}

function hashApiKey(key: string): string {
  // TODO: Implement proper hashing (SHA-256)
  return key;
}
