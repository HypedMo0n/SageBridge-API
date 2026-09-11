/**
 * Connector Job Queue Handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { isIdempotencyConflict, payloadFingerprint } from '../utils/idempotency';

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
    const claim = await env.DB.prepare(`
      UPDATE connector_jobs
      SET status = 'processing',
          started_at = COALESCE(started_at, datetime('now')),
          claimed_at = datetime('now'),
          claim_expires_at = datetime('now', '+2 minutes'),
          attempts = attempts + 1
      WHERE id = ?
        AND tenant_id = ?
        AND company_id = ?
        AND status = 'pending'
    `).bind(jobId, tenantId, companyId).run();

    if ((claim.meta.changes || 0) !== 1) {
      const existing = await env.DB.prepare(`
        SELECT status FROM connector_jobs
        WHERE id = ? AND tenant_id = ? AND company_id = ?
      `).bind(jobId, tenantId, companyId).first();

      return jsonResponse({
        error: existing ? 'Job is not available to claim' : 'Job not found',
        status: existing?.status || null
      }, existing ? 409 : 404);
    }

    return jsonResponse({ success: true, status: 'processing' });
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

    // Read the scoped job before accepting a terminal result.
    const job = await env.DB.prepare(`
      SELECT action, status, result, error
      FROM connector_jobs
      WHERE id = ? AND tenant_id = ? AND company_id = ?
    `).bind(jobId, tenantId, companyId).first<{
      action: string;
      status: string;
      result: string | null;
      error: string | null;
    }>();

    if (!job) {
      return jsonResponse({ error: 'Job not found' }, 404);
    }

    if (job.status === 'succeeded' || job.status === 'failed') {
      if (job.status === status) {
        return jsonResponse({ success: true, existing: true });
      }
      return jsonResponse({ error: 'Job already has a different terminal status' }, 409);
    }

    if (job.status !== 'processing') {
      return jsonResponse({ error: 'Job must be claimed before submitting a result' }, 409);
    }

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

    const completion = await env.DB.prepare(`
      UPDATE connector_jobs
      SET status = ?,
          result = ?,
          error = ?,
          completed_at = datetime('now'),
          claim_expires_at = NULL
      WHERE id = ?
        AND tenant_id = ?
        AND company_id = ?
        AND status = 'processing'
    `).bind(
      status,
      result,
      error || null,
      jobId,
      tenantId,
      companyId
    ).run();

    if ((completion.meta.changes || 0) !== 1) {
      return jsonResponse({ error: 'Job result was not accepted' }, 409);
    }

    return jsonResponse({ success: true, existing: false });
  } catch (error: any) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// Create a new job with payload-bound idempotency.
export async function createJob(
  tenantId: string,
  companyId: string,
  requestId: string,
  action: string,
  payload: unknown,
  env: Env
): Promise<{ jobId: string; existing: boolean; conflict: boolean }> {
  const fingerprint = await payloadFingerprint(action, payload);
  const existing = await env.DB.prepare(`
    SELECT id, action, payload, payload_hash
    FROM connector_jobs
    WHERE request_id = ? AND tenant_id = ? AND company_id = ?
  `).bind(requestId, tenantId, companyId).first();

  if (existing) {
    const existingFingerprint = existing.payload_hash
      ? String(existing.payload_hash)
      : await payloadFingerprint(String(existing.action), JSON.parse(String(existing.payload)));

    return {
      jobId: String(existing.id),
      existing: true,
      conflict: isIdempotencyConflict(
        String(existing.action),
        existingFingerprint,
        action,
        fingerprint
      )
    };
  }

  const jobId = `job_${Date.now()}_${crypto.randomUUID()}`;
  const insert = await env.DB.prepare(`
    INSERT OR IGNORE INTO connector_jobs
      (id, tenant_id, company_id, request_id, action, payload, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    jobId,
    tenantId,
    companyId,
    requestId,
    action,
    JSON.stringify(payload),
    fingerprint
  ).run();

  if ((insert.meta.changes || 0) === 1) {
    return { jobId, existing: false, conflict: false };
  }

  // A concurrent request inserted the same key after our initial read.
  const raced = await env.DB.prepare(`
    SELECT id, action, payload, payload_hash
    FROM connector_jobs
    WHERE request_id = ? AND tenant_id = ? AND company_id = ?
  `).bind(requestId, tenantId, companyId).first();

  if (!raced) {
    throw new Error('Idempotency key is unavailable in this company scope');
  }

  const racedFingerprint = raced.payload_hash
    ? String(raced.payload_hash)
    : await payloadFingerprint(String(raced.action), JSON.parse(String(raced.payload)));

  return {
    jobId: String(raced.id),
    existing: true,
    conflict: isIdempotencyConflict(String(raced.action), racedFingerprint, action, fingerprint)
  };
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
