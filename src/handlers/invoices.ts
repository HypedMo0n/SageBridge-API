/**
 * Invoices API handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';

export async function handleGetInvoices(
  tenantId: string,
  companyId: string,
  env: Env
): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT 
        i.id, i.sage_id as sageId, i.invoice_number as invoiceNumber,
        i.date, i.due_date as dueDate, i.total, i.balance, i.status,
        i.customer_sage_id as customerSageId,
        c.name as customerName
      FROM invoices i
      LEFT JOIN customers c ON i.customer_sage_id = c.sage_id 
        AND i.tenant_id = c.tenant_id 
        AND i.company_id = c.company_id
      WHERE i.tenant_id = ? AND i.company_id = ?
      ORDER BY i.date DESC
    `).bind(tenantId, companyId).all();

    return jsonResponse({
      invoices: results,
      count: results.length
    });
  } catch (error) {
    console.error('Failed to fetch invoices:', error);
    return jsonResponse({ error: 'Failed to fetch invoices' }, 500);
  }
}

export async function handleGetInvoice(
  tenantId: string,
  companyId: string,
  id: string,
  env: Env
): Promise<Response> {
  try {
    const invoice = await env.DB.prepare(`
      SELECT 
        i.id, i.sage_id as sageId, i.invoice_number as invoiceNumber,
        i.date, i.due_date as dueDate, i.total, i.balance, i.status,
        i.description, i.customer_sage_id as customerSageId,
        c.name as customerName, c.email as customerEmail, c.phone as customerPhone
      FROM invoices i
      LEFT JOIN customers c ON i.customer_sage_id = c.sage_id 
        AND i.tenant_id = c.tenant_id 
        AND i.company_id = c.company_id
      WHERE i.tenant_id = ? AND i.company_id = ? AND i.sage_id = ?
    `).bind(tenantId, companyId, id).first();

    if (!invoice) {
      return jsonResponse({ error: 'Invoice not found' }, 404);
    }

    return jsonResponse({ invoice });
  } catch (error) {
    console.error('Failed to fetch invoice:', error);
    return jsonResponse({ error: 'Failed to fetch invoice' }, 500);
  }
}
