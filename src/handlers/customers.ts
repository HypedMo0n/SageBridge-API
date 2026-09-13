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
            id, sage_id as sageId, name, contact, email, phone,
            alternate_phone as alternatePhone, fax, balance,
            home_currency_balance as homeCurrencyBalance,
            credit_limit as creditLimit, status,
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
      SELECT
        id, sage_id as sageId, name, contact, email, phone,
        alternate_phone as alternatePhone, fax, credit_limit as creditLimit,
        balance, home_currency_balance as homeCurrencyBalance, status,
        address, city, province, postal_code as postalCode,
        last_synced_at as lastSyncedAt
      FROM customers
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
    const { customer, idempotencyKey } = body;

    // Validate payload
    if (!customer || !customer.name) {
      return jsonResponse({ error: 'customer.name is required' }, 400);
    }

    if (!idempotencyKey) {
      return jsonResponse({ error: 'idempotencyKey is required' }, 400);
    }

    // Create job in queue
    const { jobId, existing, conflict } = await createJob(
      tenantId,
      companyId,
      idempotencyKey,
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
        WHERE id = ?
      `).bind(jobId).first();

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
