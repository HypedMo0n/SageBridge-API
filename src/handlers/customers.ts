/**
 * Customers API handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { createJob } from './connector';
import { parseBoundedJson, isRecord, requiredString } from '../security/security';

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
    const body = await parseBoundedJson(request, 32 * 1024) as any;
    if (!isRecord(body)) return jsonResponse({ error: 'JSON object required' }, 400);
    const { customer, idempotencyKey } = body;

    if (!isRecord(customer)) return jsonResponse({ error: 'customer is required' }, 400);
    let normalizedIdempotencyKey: string;
    try {
      customer.name = requiredString(customer.name, 'customer.name', 160);
      normalizedIdempotencyKey = requiredString(idempotencyKey, 'idempotencyKey', 128);
      for (const field of ['email', 'phone', 'address', 'city', 'province', 'postalCode']) {
        if (customer[field] != null && (typeof customer[field] !== 'string' || customer[field].length > 320)) {
          return jsonResponse({ error: `customer.${field} is invalid` }, 400);
        }
      }
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid payload' }, 400);
    }

    // Create job in queue
    const { jobId, existing, conflict } = await createJob(
      tenantId,
      companyId,
      normalizedIdempotencyKey,
      'customer.create',
      customer, // Clean customer object only
      env
    );

    if (conflict) {
      return jsonResponse({
        error: 'Idempotency key was already used with a different request',
        code: 'IDEMPOTENCY_CONFLICT'
      }, 409);
    }

    if (existing) {
      // Return existing job status
      const job = await env.DB.prepare(`
        SELECT id, status
        FROM connector_jobs
        WHERE id = ? AND tenant_id = ? AND company_id = ?
      `).bind(jobId, tenantId, companyId).first();

      return jsonResponse({
        jobId,
        status: job?.status || 'pending',
        message: 'Request already submitted'
      });
    }

    // New job created
    return jsonResponse({
      jobId,
      status: 'pending',
      message: 'Customer creation job queued'
    }, 201);
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}
