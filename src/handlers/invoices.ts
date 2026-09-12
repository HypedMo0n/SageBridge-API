/**
 * Invoices API handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { createJob } from './connector';
import { InvoiceInput, InvoiceLineInput, validateInvoicePayload } from '../utils/invoice-validation';
import { parseBoundedJson } from '../security/security';

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

/**
 * Invoice creation API handler.
 * Mirrors handleCreateQuote: queues a job for the connector, which posts a
 * narrow sales invoice through the official Sage SDK and reports back the
 * connector-assigned Sage invoice number as the job result's sageId.
 */
export async function handleCreateInvoice(
  tenantId: string,
  companyId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await parseBoundedJson(request, 32 * 1024) as { invoice?: InvoiceInput; idempotencyKey?: unknown };
    if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim()) {
      return jsonResponse({ error: 'idempotencyKey is required' }, 400);
    }

    const invoice = body.invoice as InvoiceInput;
    const validationError = validateInvoicePayload(invoice);
    if (validationError) return jsonResponse({ error: validationError }, 400);

    const normalizedInvoice = {
      customerId: (invoice.customerId as string).trim(),
      lines: (invoice.lines as InvoiceLineInput[]).map((line) => ({
        sku: (line.sku as string).trim(),
        quantity: line.quantity as number,
        unitPrice: line.unitPrice as number
      }))
    };

    const { jobId, existing, conflict } = await createJob(
      tenantId,
      companyId,
      body.idempotencyKey.trim(),
      'invoice.create',
      normalizedInvoice,
      env
    );

    if (conflict) {
      return jsonResponse({
        error: 'Idempotency key was already used with a different request',
        code: 'IDEMPOTENCY_CONFLICT'
      }, 409);
    }

    if (existing) {
      const job = await env.DB.prepare(`
        SELECT status FROM connector_jobs
        WHERE id = ? AND tenant_id = ? AND company_id = ?
      `).bind(jobId, tenantId, companyId).first();
      return jsonResponse({ jobId, status: job?.status || 'pending', message: 'Request already submitted' });
    }

    return jsonResponse({ jobId, status: 'pending', message: 'Invoice creation job queued' }, 201);
  } catch (error) {
    console.error('Failed to create invoice job:', error);
    return jsonResponse({ error: 'Failed to create invoice' }, 500);
  }
}
