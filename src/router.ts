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
import { handleGetInvoices, handleGetInvoice, handleCreateInvoice } from './handlers/invoices';
import { handleGetProducts } from './handlers/products';
import { handleGetCompanies, handleCreateCompany } from './handlers/companies';
import { handleCreateQuote } from './handlers/quotes';
import { handleSyncCustomers, handleSyncInvoices, handleSyncProducts } from './handlers/sync';
import { handleGetJob } from './handlers/jobs';
import { 
  handleGetConnectorJobs, 
  handleStartJob,
  handleJobResult,
  handleGetJobStatus 
} from './handlers/connector';

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
    return jsonResponse({ error: 'Unauthorized', message: authResult.error }, authResult.status || 401);
  }

  const { tenantId, companyId, principal } = authResult;

  const connectorOnly = path.startsWith('/connector/') || path.startsWith('/sync/');
  if (connectorOnly && principal !== 'connector') {
    return jsonResponse({ error: 'Connector credential required' }, 403);
  }
  if (path.startsWith('/api/') && principal !== 'user') {
    return jsonResponse({ error: 'User credential required' }, 403);
  }

  if (path === '/api/companies' && method === 'GET') {
    return handleGetCompanies(tenantId!, env);
  }

  if (path === '/api/companies' && method === 'POST') {
    return handleCreateCompany(request, tenantId!, env);
  }

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

  if (path === '/api/invoices' && method === 'POST') {
    return handleCreateInvoice(tenantId!, companyId!, request, env);
  }

  if (path.match(/^\/api\/invoices\/[\w-]+$/) && method === 'GET') {
    const id = path.split('/').pop()!;
    return handleGetInvoice(tenantId!, companyId!, id, env);
  }

  if (path === '/api/products' && method === 'GET') {
    return handleGetProducts(tenantId!, companyId!, env);
  }

  if (path === '/api/quotes' && method === 'POST') {
    return handleCreateQuote(tenantId!, companyId!, request, env);
  }

  // Connector sync routes
  if (path === '/sync/customers' && method === 'POST') {
    return handleSyncCustomers(request, tenantId!, companyId!, env);
  }

  if (path === '/sync/invoices' && method === 'POST') {
    return handleSyncInvoices(request, tenantId!, companyId!, env);
  }

  if (path === '/sync/products' && method === 'POST') {
    return handleSyncProducts(request, tenantId!, companyId!, env);
  }

  // Frontend-facing job status API
  if (path.match(/^\/api\/jobs\/[\w-]+$/) && method === 'GET') {
    const jobId = path.split('/')[3];
    return handleGetJob(jobId, tenantId!, companyId!, env);
  }

  // Connector-facing job queue routes (backend only)
  if (path === '/connector/jobs' && method === 'GET') {
    return handleGetConnectorJobs(tenantId!, companyId!, env);
  }

  if (path.match(/^\/connector\/jobs\/[\w-]+\/start$/) && method === 'POST') {
    const jobId = path.split('/')[3];
    return handleStartJob(jobId, tenantId!, companyId!, env);
  }

  if (path.match(/^\/connector\/jobs\/[\w-]+\/result$/) && method === 'POST') {
    const jobId = path.split('/')[3];
    return handleJobResult(jobId, tenantId!, companyId!, request, env);
  }

  // 404 Not Found
  return jsonResponse({ error: 'Not Found', path, method }, 404);
}
