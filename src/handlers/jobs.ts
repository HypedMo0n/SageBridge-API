/**
 * Generic Job Status API
 * Frontend-facing endpoint for checking job status
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';

export async function handleGetJob(
  jobId: string,
  tenantId: string,
  companyId: string,
  env: Env
): Promise<Response> {
  try {
    const job = await env.DB.prepare(`
      SELECT 
        id, 
        action, 
        status, 
        result, 
        error, 
        created_at as createdAt,
        started_at as startedAt,
        completed_at as completedAt
      FROM connector_jobs
      WHERE id = ?
        AND tenant_id = ?
        AND company_id = ?
    `).bind(jobId, tenantId, companyId).first();

    if (!job) {
      return jsonResponse({ error: 'Job not found' }, 404);
    }

    // Parse result if present
    let resource = null;
    if (job.result) {
      try {
        const resultData = JSON.parse(job.result as string);
        resource = resultData.resource || null;
      } catch {
        // Ignore parse errors
      }
    }

    // Clean response for frontend
    return jsonResponse({
      jobId: job.id,
      status: job.status, // pending | claimed | running | succeeded | failed
      action: job.action,
      resource, // { type: 'customer', id: 'sage_123' }
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    });
  } catch (error) {
    console.error('Failed to fetch job:', error);
    return jsonResponse({ error: 'Failed to fetch job' }, 500);
  }
}
