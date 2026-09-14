import { Env } from '../index';
import { jsonResponse } from '../utils/response';

export async function handleCreateCompany(request: Request, tenantId: string, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Request body must be valid JSON' }, 400);
  }

  const name = typeof body === 'object' && body !== null && 'name' in body
    ? String((body as { name: unknown }).name).trim()
    : '';
  if (!name || name.length > 120) {
    return jsonResponse({ error: 'Company name must contain 1 to 120 characters' }, 400);
  }

  const id = `company_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO companies (
        id, tenant_id, sage_company_name, connector_status, created_at, updated_at
      ) VALUES (?, ?, ?, 'offline', ?, ?)
    `).bind(id, tenantId, name, now, now).run();

    return jsonResponse({
      company: { id, name, connectorStatus: 'offline', lastSyncAt: null }
    }, 201);
  } catch (error) {
    return jsonResponse({
      error: 'Could not create company',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}

export async function handleGetCompanies(tenantId: string, env: Env): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT
        id,
        sage_company_name,
        connector_status,
        last_sync_at
      FROM companies
      WHERE tenant_id = ?
      ORDER BY sage_company_name COLLATE NOCASE, id
    `).bind(tenantId).all();

    const companies = results.map((row: any) => ({
      id: row.id,
      name: row.sage_company_name,
      connectorStatus: row.connector_status,
      lastSyncAt: row.last_sync_at
    }));

    return jsonResponse({ companies });
  } catch (error) {
    return jsonResponse({
      error: 'Could not list companies',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}
