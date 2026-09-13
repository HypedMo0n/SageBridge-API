/**
 * Products API handlers
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';

export async function handleGetProducts(
  tenantId: string,
  companyId: string,
  env: Env
): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(`
      SELECT 
        id, sage_id as sageId, sku, name, description, unit,
        price, stock, reorder_level as reorderLevel,
        category, is_service as isService, status,
        last_synced_at as lastSyncedAt
      FROM products
      WHERE tenant_id = ? AND company_id = ?
      ORDER BY name ASC
    `).bind(tenantId, companyId).all();

    // Separate products and services
    const products = results.filter((p: any) => !p.isService);
    const services = results.filter((p: any) => p.isService);

    return jsonResponse({
      products,
      services,
      all: results,
      count: results.length
    });
  } catch (error) {
    return jsonResponse({
      error: 'Failed to fetch products',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}
