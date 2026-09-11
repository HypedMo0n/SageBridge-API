/**
 * Customers API handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { createJob } from './connector';

export async function handleGetCustomers(
  tenantId: string,
  companyId: string,
  env: Env
): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT 
        id, sage_id as sageId, name, email, phone, balance, status,
        address, city, province, postal_code as postalCode,
        last_synced_at as lastSyncedAt
      FROM customers
      WHERE tenant_id = ? AND company_id = ?
      ORDER BY name ASC
    `).bind(tenantId, companyId).all();

    return jsonResponse({
      customers: results,
      count: results.length,
      tenantId,
      companyId
    });
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleGetCustomer(
  tenantId: string,
  companyId: string,
  id: string,
  env: Env
): Promise<Response> {
  try {
    const customer = await env.DB.prepare(`
      SELECT * FROM customers
      WHERE tenant_id = ? AND company_id = ? AND (id = ? OR sage_id = ?)
    `).bind(tenantId, companyId, id, id).first();

    if (!customer) {
      return jsonResponse({ error: 'Customer not found' }, 404);
    }

    return jsonResponse({ customer });
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}

export async function handleCreateCustomer(
  tenantId: string,
  companyId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { name, email, phone, requestId } = body;

    if (!name) {
      return jsonResponse({ error: 'Customer name is required' }, 400);
    }

    if (!requestId) {
      return jsonResponse({ error: 'requestId is required for idempotency' }, 400);
    }

    // Create job in queue
    const { jobId, existing } = await createJob(
      tenantId,
      companyId,
      requestId,
      'customer.create',
      { name, email, phone },
      env
    );

    return jsonResponse({
      jobId,
      requestId,
      existing,
      message: existing 
        ? 'Request already submitted' 
        : 'Job created, connector will process shortly'
    }, existing ? 200 : 201);
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}
