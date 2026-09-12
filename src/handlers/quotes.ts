/**
 * Quote creation API handler.
 * The connector generates OrderQuoteNum as QT-YYYYMMDD-NNN.
 */
import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { createJob } from './connector';
import { QuoteInput, QuoteLineInput, validateQuotePayload } from '../utils/quote-validation';
import { parseBoundedJson } from '../security/security';

export async function handleGetQuotes(
  tenantId: string,
  companyId: string,
  env: Env
): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT payload_json FROM quotes
      WHERE tenant_id = ? AND company_id = ?
      ORDER BY last_synced_at DESC, sage_id DESC
    `).bind(tenantId, companyId).all<{ payload_json: string }>();
    const quotes = results.map((row) => JSON.parse(row.payload_json));
    return jsonResponse({ quotes, count: quotes.length });
  } catch (error) {
    console.error('Failed to fetch quotes:', error);
    return jsonResponse({ error: 'Failed to fetch quotes' }, 500);
  }
}

export async function handleCreateQuote(
  tenantId: string,
  companyId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await parseBoundedJson(request, 32 * 1024) as { quote?: QuoteInput; idempotencyKey?: unknown };
    if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim()) {
      return jsonResponse({ error: 'idempotencyKey is required' }, 400);
    }

    const quote = body.quote as QuoteInput;
    const validationError = validateQuotePayload(quote);
    if (validationError) return jsonResponse({ error: validationError }, 400);

    const normalizedQuote = {
      customerId: (quote.customerId as string).trim(),
      lines: (quote.lines as QuoteLineInput[]).map((line) => ({
        sku: (line.sku as string).trim(),
        quantity: line.quantity as number,
        unitPrice: line.unitPrice as number
      }))
    };

    const { jobId, existing, conflict } = await createJob(
      tenantId,
      companyId,
      body.idempotencyKey.trim(),
      'quote.create',
      normalizedQuote,
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

    return jsonResponse({ jobId, status: 'pending', message: 'Quote creation job queued' }, 201);
  } catch (error) {
    console.error('Failed to create quote job:', error);
    return jsonResponse({ error: 'Failed to create quote' }, 500);
  }
}
