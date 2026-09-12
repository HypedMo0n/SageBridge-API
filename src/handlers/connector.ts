/**
 * Connector Job Queue Handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { isIdempotencyConflict, payloadFingerprint } from '../utils/idempotency';
import { parseBoundedJson } from '../security/security';

// Get pending jobs for a connector
export async function handleGetConnectorJobs(
  tenantId: string,
  companyId: string,
  env: Env,
  connectorId?: string
): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT id, action, payload, request_id, attempts, created_at
      FROM connector_jobs
      WHERE tenant_id = ? 
        AND company_id = ?
        AND (status = 'pending' OR (status IN ('claimed','running') AND claim_expires_at < datetime('now') AND attempts < max_attempts))
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
  } catch (error) {
    console.error('Failed to fetch connector jobs:', error);
    return jsonResponse({ error: 'Failed to fetch jobs' }, 500);
  }
}

// Mark job as processing
export async function handleStartJob(
  jobId: string,
  tenantId: string,
  companyId: string,
  env: Env,
  connectorId?: string
): Promise<Response> {
  try {
    const claim = await env.DB.prepare(`
      UPDATE connector_jobs
      SET status = 'running',
          started_at = COALESCE(started_at, datetime('now')),
          claimed_at = datetime('now'),
          claim_expires_at = datetime('now', '+2 minutes'),
          attempts = attempts + 1,
          connector_id = ?
      WHERE id = ?
        AND tenant_id = ?
        AND company_id = ?
        AND (status = 'pending' OR (status IN ('claimed','running') AND claim_expires_at < datetime('now')))
        AND attempts < max_attempts
    `).bind(connectorId || null, jobId, tenantId, companyId).run();

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

    return jsonResponse({ success: true, status: 'running' });
  } catch (error) {
    console.error('Failed to start job:', error);
    return jsonResponse({ error: 'Failed to start job' }, 500);
  }
}

// Submit job result
export async function handleJobResult(
  jobId: string,
  tenantId: string,
  companyId: string,
  request: Request,
  env: Env,
  connectorId?: string
): Promise<Response> {
  try {
    const body = await parseBoundedJson(request, 32 * 1024) as any;
    const { status, sageId, error } = body;

    if (!status || !['succeeded', 'failed'].includes(status)) {
      return jsonResponse({ error: 'Invalid status (must be succeeded or failed)' }, 400);
    }
    const sageIdValue = typeof sageId === 'string' ? sageId.trim() : '';
    const errorValue = typeof error === 'string' ? error.trim() : '';
    if (status === 'succeeded' && (!sageIdValue || sageIdValue.length > 256)) {
      return jsonResponse({ error: 'A non-empty sageId (max 256 characters) is required for succeeded jobs' }, 400);
    }
    if (status === 'failed' && (!errorValue || errorValue.length > 2000)) {
      return jsonResponse({ error: 'A non-empty error (max 2000 characters) is required for failed jobs' }, 400);
    }

    // Read the scoped job before accepting a terminal result.
    const job = await env.DB.prepare(`
      SELECT action, status, result, error, connector_id, claim_expires_at
      FROM connector_jobs
      WHERE id = ? AND tenant_id = ? AND company_id = ?
    `).bind(jobId, tenantId, companyId).first<{
      action: string;
      status: string;
      result: string | null;
      error: string | null;
      connector_id: string | null;
      claim_expires_at: string | null;
    }>();

    if (!job) {
      return jsonResponse({ error: 'Job not found' }, 404);
    }
    if (connectorId && job.connector_id !== connectorId) {
      return jsonResponse({ error: 'Job is claimed by another connector' }, 403);
    }

    if (job.status === 'succeeded' || job.status === 'failed') {
      if (job.status === status) {
        let matches = false;
        if (status === 'succeeded' && job.result) {
          try { matches = JSON.parse(job.result)?.resource?.id === sageIdValue; } catch { matches = false; }
        } else if (status === 'failed') {
          matches = (job.error || '') === errorValue;
        }
        if (matches) return jsonResponse({ success: true, existing: true });
        return jsonResponse({ error: 'Job already has a different terminal result' }, 409);
      }
      return jsonResponse({ error: 'Job already has a different terminal status' }, 409);
    }

    if (!job.claim_expires_at || Date.parse(`${job.claim_expires_at}Z`) <= Date.now()) {
      return jsonResponse({ error: 'Job claim has expired' }, 409);
    }

    if (!['claimed','running'].includes(job.status)) {
      return jsonResponse({ error: 'Job must be claimed before submitting a result' }, 409);
    }

    let result = null;
    if (status === 'succeeded') {
      // Extract resource type from action
      const resourceType = job?.action?.split('.')[0]; // 'customer.create' → 'customer'
      
      result = JSON.stringify({
        resource: {
          type: resourceType,
          id: sageIdValue
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
        AND status IN ('claimed','running')
        AND connector_id = ?
        AND claim_expires_at > datetime('now')
    `).bind(
      status,
      result,
      errorValue || null,
      jobId,
      tenantId,
      companyId
      ,connectorId || null
    ).run();

    if ((completion.meta.changes || 0) !== 1) {
      return jsonResponse({ error: 'Job result was not accepted' }, 409);
    }

    return jsonResponse({ success: true, existing: false });
  } catch (error) {
    console.error('Failed to submit job result:', error);
    return jsonResponse({ error: 'Failed to submit job result' }, 500);
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
  } catch (error) {
    console.error('Failed to fetch job status:', error);
    return jsonResponse({ error: 'Failed to fetch job status' }, 500);
  }
}
