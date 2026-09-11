/**
 * API Router
 * Routes requests to appropriate handlers
 */

import { Env } from './index';
import { authenticate } from './middleware/auth';
import { jsonResponse } from './utils/response';

// Import handlers
import { handleHealth } from './handlers/health';
import { handleGetCustomers, handleGetCustomer, handleCreateCustomer } from './handlers/customers';
import { handleGetInvoices, handleGetInvoice } from './handlers/invoices';
import { handleGetProducts } from './handlers/products';
import { handleSyncCustomers, handleSyncInvoices, handleSyncProducts } from './handlers/sync';

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Public health check
  if (path === '/health' && method === 'GET') {
    return handleHealth(env);
  }

  // All other routes require authentication
  const authResult = await authenticate(request, env);
  if (!authResult.authenticated) {
    return jsonResponse({ error: 'Unauthorized', message: authResult.error }, 401);
  }

  const { tenantId, companyId } = authResult;

  // Mobile API routes (read-only for now)
  if (path === '/api/customers' && method === 'GET') {
    return handleGetCustomers(tenantId!, companyId!, env);
  }

  if (path.match(/^\/api\/customers\/[\w-]+$/) && method === 'GET') {
    const id = path.split('/').pop()!;
    return handleGetCustomer(tenantId!, companyId!, id, env);
  }

  if (path === '/api/customers' && method === 'POST') {
    return handleCreateCustomer(tenantId!, companyId!, request, env);
  }

  if (path === '/api/invoices' && method === 'GET') {
    return handleGetInvoices(tenantId!, companyId!, env);
  }

  if (path.match(/^\/api\/invoices\/[\w-]+$/) && method === 'GET') {
    const id = path.split('/').pop()!;
    return handleGetInvoice(tenantId!, companyId!, id, env);
  }

  if (path === '/api/products' && method === 'GET') {
    return handleGetProducts(tenantId!, companyId!, env);
  }

  // Connector sync routes
  if (path === '/sync/customers' && method === 'POST') {
    return handleSyncCustomers(request, env);
  }

  if (path === '/sync/invoices' && method === 'POST') {
    return handleSyncInvoices(request, env);
  }

  if (path === '/sync/products' && method === 'POST') {
    return handleSyncProducts(request, env);
  }

  // 404 Not Found
  return jsonResponse({ error: 'Not Found', path, method }, 404);
}
