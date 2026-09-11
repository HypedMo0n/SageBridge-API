/**
 * Customers API handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';

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
  } catch (error) {
    return jsonResponse({
      error: 'Failed to fetch customers',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
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
        id, sage_id as sageId, name, email, phone, balance, status,
        address, city, province, postal_code as postalCode,
        last_synced_at as lastSyncedAt
      FROM customers
      WHERE tenant_id = ? AND company_id = ? AND sage_id = ?
    `).bind(tenantId, companyId, id).first();

    if (!customer) {
      return jsonResponse({ error: 'Customer not found' }, 404);
    }

    // Get customer invoices
    const { results: invoices } = await env.DB.prepare(`
      SELECT 
        id, sage_id as sageId, invoice_number as invoiceNumber,
        date, total, balance, status
      FROM invoices
      WHERE tenant_id = ? AND company_id = ? AND customer_sage_id = ?
      ORDER BY date DESC
      LIMIT 10
    `).bind(tenantId, companyId, id).all();

    return jsonResponse({
      customer,
      invoices
    });
  } catch (error) {
    return jsonResponse({
      error: 'Failed to fetch customer',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
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
    const { name, email, phone } = body;

    if (!name) {
      return jsonResponse({ error: 'Name is required' }, 400);
    }

    // Generate sage_id (in production, this comes from Sage)
    const sageId = `CUST${Date.now().toString().substring(7)}`;

    const result = await env.DB.prepare(`
      INSERT INTO customers (tenant_id, company_id, sage_id, name, email, phone, balance, status)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'Active')
      RETURNING id, sage_id as sageId, name, email, phone, balance, status
    `).bind(tenantId, companyId, sageId, name, email || null, phone || null).first();

    return jsonResponse({
      customer: result,
      message: 'Customer created successfully'
    }, 201);
  } catch (error) {
    return jsonResponse({
      error: 'Failed to create customer',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}
