/**
 * Sync handlers - Receive data from Windows Connector
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { parseBoundedJson } from '../security/security';

function conflictingCompany(body: any, companyId: string): Response | null {
  const supplied=body?.companyId??body?.company_id;
  return supplied!=null&&supplied!==companyId
    ? jsonResponse({error:'Payload company does not match authenticated connector',code:'COMPANY_SCOPE_CONFLICT'},409)
    : null;
}

async function recordSync(env: Env, tenantId: string, companyId: string, connectorId: string, entityType: string, records: number) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sync_events (tenant_id,company_id,entity_type,records_synced,status) VALUES (?,?,?,?,'success')`).bind(tenantId,companyId,entityType,records),
    env.DB.prepare(`UPDATE connectors SET last_sync_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND company_id=? AND status='active'`).bind(connectorId,tenantId,companyId),
    env.DB.prepare(`UPDATE companies SET last_sync_at=CURRENT_TIMESTAMP,connector_status='connected' WHERE organization_id=? AND id=?`).bind(tenantId,companyId),
  ]);
}

export async function handleSyncCustomers(request: Request, env: Env, tenantId: string, companyId: string, connectorId: string): Promise<Response> {
  try {
    const body = await parseBoundedJson(request, 1024 * 1024) as any;
    const conflict=conflictingCompany(body,companyId); if(conflict)return conflict;
    const { Customers } = body;

    if (!Array.isArray(Customers) || Customers.length > 5000) {
      return jsonResponse({ error: 'Missing required fields' }, 400);
    }

    let synced = 0;
    let errors = 0;
    const snapshotToken = new Date().toISOString();

    // Upsert each customer
    for (const customer of Customers) {
      try {
        await env.DB.prepare(`
          INSERT INTO customers (
            tenant_id, company_id, sage_id, name, email, phone, balance, status, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, company_id, sage_id) DO UPDATE SET
            name = excluded.name,
            email = excluded.email,
            phone = excluded.phone,
            balance = excluded.balance,
            status = excluded.status,
            last_synced_at = excluded.last_synced_at
        `).bind(
          tenantId,
          companyId,
          customer.Id,
          customer.Name,
          customer.Email || null,
          customer.Phone || null,
          customer.Balance || 0,
          customer.Status || 'Active',
          snapshotToken
        ).run();
        
        synced++;
      } catch (error) {
        console.error('Failed to sync customer:', customer.Id, error);
        errors++;
      }
    }

    // The connector sends a complete Sage customer snapshot. Remove cloud
    // records absent from that snapshot only when every upsert succeeded.
    let deleted = 0;
    if (errors === 0) {
      const deletionResult = await env.DB.prepare(`
        DELETE FROM customers
        WHERE tenant_id = ? AND company_id = ? AND last_synced_at <> ?
      `).bind(tenantId, companyId, snapshotToken).run();
      deleted = deletionResult.meta.changes || 0;
    }

    // Log sync event
    await env.DB.prepare(`
      INSERT INTO sync_events (tenant_id, company_id, entity_type, records_synced, status)
      VALUES (?, ?, 'customers', ?, ?)
    `).bind(tenantId, companyId, synced, errors > 0 ? 'partial' : 'success').run();

    // Update company last_sync
    await env.DB.prepare(`
      UPDATE companies SET last_sync_at = CURRENT_TIMESTAMP, connector_status = 'connected'
      WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, companyId).run();
    await env.DB.prepare(`UPDATE connectors SET last_sync_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND company_id=? AND status='active'`).bind(connectorId,tenantId,companyId).run();

    return jsonResponse({
      success: errors === 0,
      synced,
      deleted,
      errors,
      total: Customers.length
    }, errors > 0 ? 207 : 200);
  } catch (error) {
    console.error('Customer sync failed:', error);
    return jsonResponse({ error: 'Sync failed' }, 500);
  }
}

export async function handleSyncInvoices(request: Request, env: Env, tenantId: string, companyId: string, connectorId: string): Promise<Response> {
  try {
    const body = await parseBoundedJson(request, 1024 * 1024) as any;
    const conflict=conflictingCompany(body,companyId); if(conflict)return conflict;
    const { Invoices } = body;

    if (!Array.isArray(Invoices) || Invoices.length > 5000) {
      return jsonResponse({ error: 'Missing required fields' }, 400);
    }
    if (Invoices.some((invoice:any)=>typeof invoice?.Id!=='string'||!invoice.Id.trim()||typeof invoice?.InvoiceNumber!=='string'||!invoice.InvoiceNumber.trim()||typeof invoice?.Date!=='string'||!invoice.Date.trim())) {
      return jsonResponse({ error: 'Every invoice requires Id, InvoiceNumber, and Date' }, 400);
    }

    let synced = 0;
    let errors = 0;

    for (const invoice of Invoices) {
      try {
        await env.DB.prepare(`
          INSERT INTO invoices (
            tenant_id, company_id, sage_id, customer_sage_id, invoice_number,
            date, due_date, total, balance, status, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(tenant_id, company_id, sage_id) DO UPDATE SET
            customer_sage_id = excluded.customer_sage_id,
            invoice_number = excluded.invoice_number,
            date = excluded.date,
            due_date = excluded.due_date,
            total = excluded.total,
            balance = excluded.balance,
            status = excluded.status,
            last_synced_at = CURRENT_TIMESTAMP
        `).bind(
          tenantId,
          companyId,
          invoice.Id,
          invoice.CustomerId || null,
          invoice.InvoiceNumber,
          invoice.Date,
          invoice.DueDate || null,
          invoice.Total || 0,
          invoice.Balance || 0,
          invoice.Status || 'Unpaid'
        ).run();
        
        synced++;
      } catch (error) {
        errors++;
      }
    }

    await env.DB.prepare(`
      INSERT INTO sync_events (tenant_id, company_id, entity_type, records_synced, status)
      VALUES (?, ?, 'invoices', ?, ?)
    `).bind(tenantId, companyId, synced, errors > 0 ? 'partial' : 'success').run();
    await env.DB.prepare(`UPDATE connectors SET last_sync_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND company_id=? AND status='active'`).bind(connectorId,tenantId,companyId).run();

    return jsonResponse({ success: errors === 0, synced, errors, total: Invoices.length }, errors > 0 ? 207 : 200);
  } catch (error) {
    console.error('Invoice sync failed:', error);
    return jsonResponse({ error: 'Sync failed' }, 500);
  }
}

export async function handleSyncProducts(request: Request, env: Env, tenantId: string, companyId: string, connectorId: string): Promise<Response> {
  try {
    const body = await parseBoundedJson(request, 1024 * 1024) as any;
    const conflict=conflictingCompany(body,companyId); if(conflict)return conflict;
    const { Products } = body;

    if (!Array.isArray(Products) || Products.length > 5000) {
      return jsonResponse({ error: 'Missing required fields' }, 400);
    }
    if (Products.some((product:any)=>typeof product?.Id!=='string'||!product.Id.trim()||typeof product?.SKU!=='string'||!product.SKU.trim()||typeof product?.Name!=='string'||!product.Name.trim())) {
      return jsonResponse({ error: 'Every product requires Id, SKU, and Name' }, 400);
    }

    let synced = 0;
    let errors = 0;

    for (const product of Products) {
      try {
        await env.DB.prepare(`
          INSERT INTO products (
            tenant_id, company_id, sage_id, sku, name, price,
            stock, reorder_level, category, is_service, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(tenant_id, company_id, sage_id) DO UPDATE SET
            sku = excluded.sku,
            name = excluded.name,
            price = excluded.price,
            stock = excluded.stock,
            reorder_level = excluded.reorder_level,
            category = excluded.category,
            is_service = excluded.is_service,
            last_synced_at = CURRENT_TIMESTAMP
        `).bind(
          tenantId,
          companyId,
          product.Id,
          product.SKU,
          product.Name,
          product.Price || 0,
          typeof product.Stock === 'number' ? product.Stock : null,
          typeof product.ReorderLevel === 'number' ? product.ReorderLevel : null,
          product.Category || null,
          product.Stock == null ? 1 : 0
        ).run();
        
        synced++;
      } catch (error) {
        errors++;
      }
    }

    await env.DB.prepare(`
      INSERT INTO sync_events (tenant_id, company_id, entity_type, records_synced, status)
      VALUES (?, ?, 'products', ?, ?)
    `).bind(tenantId, companyId, synced, errors > 0 ? 'partial' : 'success').run();
    await env.DB.prepare(`UPDATE connectors SET last_sync_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND company_id=? AND status='active'`).bind(connectorId,tenantId,companyId).run();

    return jsonResponse({ success: errors === 0, synced, errors, total: Products.length }, errors > 0 ? 207 : 200);
  } catch (error) {
    console.error('Product sync failed:', error);
    return jsonResponse({ error: 'Sync failed' }, 500);
  }
}

export async function handleSyncQuotes(request: Request, env: Env, tenantId: string, companyId: string, connectorId: string): Promise<Response> {
  try {
    const body=await parseBoundedJson(request,1024*1024) as any;
    const conflict=conflictingCompany(body,companyId); if(conflict)return conflict;
    if(!Array.isArray(body.Quotes)||body.Quotes.length>5000) return jsonResponse({error:'Quotes must be an array with at most 5000 records'},400);
    if(body.Quotes.some((quote:any)=>{const id=quote?.Id??quote?.SageId??quote?.QuoteNumber; return typeof id!=='string'||!id.trim()})) return jsonResponse({error:'Every quote requires a non-empty Sage ID or quote number'},400);
    let synced=0;
    for(const quote of body.Quotes) {
      const sageId=quote?.Id??quote?.SageId??quote?.QuoteNumber;
      await env.DB.prepare(`INSERT INTO quotes(tenant_id,company_id,sage_id,payload_json,last_synced_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(tenant_id,company_id,sage_id) DO UPDATE SET payload_json=excluded.payload_json,last_synced_at=CURRENT_TIMESTAMP`).bind(tenantId,companyId,sageId,JSON.stringify(quote)).run();
      synced++;
    }
    await recordSync(env,tenantId,companyId,connectorId,'quotes',synced);
    return jsonResponse({success:true,synced,total:body.Quotes.length});
  } catch(error) { console.error('Quote sync failed:', error); return jsonResponse({error:'Sync failed'},500); }
}

export async function handleSyncInvoiceSummary(request: Request, env: Env, tenantId: string, companyId: string, connectorId: string): Promise<Response> {
  try {
    const body=await parseBoundedJson(request,256*1024) as any;
    const conflict=conflictingCompany(body,companyId); if(conflict)return conflict;
    const summary=body.InvoiceSummary??body.invoiceSummary;
    if(!summary||typeof summary!=='object'||Array.isArray(summary)) return jsonResponse({error:'InvoiceSummary object is required'},400);
    await env.DB.prepare(`INSERT INTO invoice_summaries(tenant_id,company_id,payload_json,last_synced_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(tenant_id,company_id) DO UPDATE SET payload_json=excluded.payload_json,last_synced_at=CURRENT_TIMESTAMP`).bind(tenantId,companyId,JSON.stringify(summary)).run();
    await recordSync(env,tenantId,companyId,connectorId,'invoice-summary',1);
    return jsonResponse({success:true,synced:1});
  } catch(error) { console.error('Invoice summary sync failed:', error); return jsonResponse({error:'Sync failed'},500); }
}
