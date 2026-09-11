/**
 * Health check handler
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';

export async function handleHealth(env: Env): Promise<Response> {
  try {
    // Test database connection
    const result = await env.DB.prepare('SELECT 1 as health').first();
    
    return jsonResponse({
      status: 'healthy',
      database: result ? 'connected' : 'disconnected',
      version: '1.0.0',
      environment: env.ENVIRONMENT || 'production',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return jsonResponse({
      status: 'unhealthy',
      database: 'error',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}
