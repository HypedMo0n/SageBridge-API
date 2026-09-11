/**
 * Connector Job Queue Handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';

// Get pending jobs for a connector
export async function handleGetConnectorJobs(
  tenantId: string,
  companyId: string,
  env: Env
): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, action, payload, request_id, attempts, created_at
      FROM connector_jobs
      WHERE tenant_id = ? 
        AND company_id = ?
        AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 10
    `).bind(tenantId, companyId).all();

    const jobs = results.map((row: any) => ({
      jobId: row.id,
      action: row.action,
      payload: JSON.parse(row.payload),
      requestId: row.request_id,
      attempts: row.attempts,
      createdAt: row.created_at
    }));

    return jsonResponse({ jobs });
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// Mark job as processing
export async function handleStartJob(
  jobId: string,
  tenantId: string,
  companyId: string,
  env: Env
): Promise<Response> {
  try {
    await env.DB.prepare(`
      UPDATE connector_jobs
      SET status = 'processing',
          started_at = datetime('now'),
          attempts = attempts + 1
      WHERE id = ?
        AND tenant_id = ?
        AND company_id = ?
        AND status = 'pending'
    `).bind(jobId, tenantId, companyId).run();

    return jsonResponse({ success: true });
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// Submit job result
export async function handleJobResult(
  jobId: string,
  tenantId: string,
  companyId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { status, sageId, error } = body;

    if (!status || !['succeeded', 'failed'].includes(status)) {
      return jsonResponse({ error: 'Invalid status (must be succeeded or failed)' }, 400);
    }

    // Get job action to determine resource type
    const job = await env.DB.prepare(`
      SELECT action FROM connector_jobs WHERE id = ?
    `).bind(jobId).first();

    let result = null;
    if (status === 'succeeded' && sageId) {
      // Extract resource type from action
      const resourceType = job?.action?.split('.')[0]; // 'customer.create' → 'customer'
      
      result = JSON.stringify({
        resource: {
          type: resourceType,
          id: sageId
        }
      });
    }

    await env.DB.prepare(`
      UPDATE connector_jobs
      SET status = ?,
          result = ?,
          error = ?,
          completed_at = datetime('now')
      WHERE id = ?
        AND tenant_id = ?
        AND company_id = ?
    `).bind(
      status,
      result,
      error || null,
      jobId,
      tenantId,
      companyId
    ).run();

    return jsonResponse({ success: true });
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// Create a new job (with idempotency check)
export async function createJob(
  tenantId: string,
  companyId: string,
  requestId: string,
  action: string,
  payload: any,
  env: Env
): Promise<{ jobId: string; existing: boolean }> {
  // Check if already processed
  const existing = await env.DB.prepare(`
    SELECT id, status, result, error
    FROM connector_jobs
    WHERE request_id = ?
      AND tenant_id = ?
      AND company_id = ?
  `).bind(requestId, tenantId, companyId).first();

  if (existing) {
    return {
      jobId: existing.id as string,
      existing: true
    };
  }

  // Create new job
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  await env.DB.prepare(`
    INSERT INTO connector_jobs (id, tenant_id, company_id, request_id, action, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    jobId,
    tenantId,
    companyId,
    requestId,
    action,
    JSON.stringify(payload)
  ).run();

  return { jobId, existing: false };
}

// Get job status
export async function handleGetJobStatus(
  jobId: string,
  tenantId: string,
  companyId: string,
  env: Env
): Promise<Response> {
  try {
    const job = await env.DB.prepare(`
      SELECT id, action, status, result, error, created_at, started_at, completed_at
      FROM connector_jobs
      WHERE id = ?
        AND tenant_id = ?
        AND company_id = ?
    `).bind(jobId, tenantId, companyId).first();

    if (!job) {
      return jsonResponse({ error: 'Job not found' }, 404);
    }

    return jsonResponse({
      jobId: job.id,
      action: job.action,
      status: job.status,
      result: job.result ? JSON.parse(job.result as string) : null,
      error: job.error,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at
    });
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}
