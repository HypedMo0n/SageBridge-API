/**
 * Sync handlers - Receive data from Windows Connector
 */

import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { validateSyncScope } from '../security/company-scope';

export { validateSyncScope } from '../security/company-scope';

export async function handleSyncCustomers(request: Request, tenantId: string, companyId: string, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { Customers } = body;
    const scopeError = validateSyncScope(body, tenantId, companyId);
    if (scopeError) return jsonResponse({ error: scopeError }, 403);
    const TenantId = tenantId;
    const CompanyId = companyId;

    if (!Array.isArray(Customers)) {
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
            tenant_id, company_id, sage_id, name, contact, email, phone,
            alternate_phone, fax, address, credit_limit, balance,
            home_currency_balance, status, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, company_id, sage_id) DO UPDATE SET
            name = excluded.name,
            contact = excluded.contact,
            email = excluded.email,
            phone = excluded.phone,
            alternate_phone = excluded.alternate_phone,
            fax = excluded.fax,
            address = excluded.address,
            credit_limit = excluded.credit_limit,
            balance = excluded.balance,
            home_currency_balance = excluded.home_currency_balance,
            status = excluded.status,
            last_synced_at = excluded.last_synced_at
        `).bind(
          TenantId,
          CompanyId,
          customer.Id,
          customer.Name,
          customer.Contact ?? null,
          customer.Email ?? null,
          customer.Phone ?? null,
          customer.AlternatePhone ?? null,
          customer.Fax ?? null,
          customer.Address ?? null,
          customer.CreditLimit ?? null,
          customer.Balance ?? null,
          customer.HomeCurrencyBalance ?? null,
          customer.Status ?? null,
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
      `).bind(TenantId, CompanyId, snapshotToken).run();
      deleted = deletionResult.meta.changes || 0;
    }

    // Log sync event
    await env.DB.prepare(`
      INSERT INTO sync_events (tenant_id, company_id, entity_type, records_synced, status)
      VALUES (?, ?, 'customers', ?, ?)
    `).bind(TenantId, CompanyId, synced, errors > 0 ? 'partial' : 'success').run();

    // Update company last_sync
    await env.DB.prepare(`
      UPDATE companies SET last_sync_at = CURRENT_TIMESTAMP, connector_status = 'connected'
      WHERE tenant_id = ? AND id = ?
    `).bind(TenantId, CompanyId).run();

    return jsonResponse({
      success: true,
      synced,
      deleted,
      errors,
      total: Customers.length
    });
  } catch (error) {
    return jsonResponse({
      error: 'Sync failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}

export async function handleSyncInvoices(request: Request, tenantId: string, companyId: string, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { Invoices } = body;
    const scopeError = validateSyncScope(body, tenantId, companyId);
    if (scopeError) return jsonResponse({ error: scopeError }, 403);
    const TenantId = tenantId;
    const CompanyId = companyId;

    if (!Array.isArray(Invoices)) {
      return jsonResponse({ error: 'Missing required fields' }, 400);
    }

    let synced = 0;

    for (const invoice of Invoices) {
      try {
        await env.DB.prepare(`
          INSERT INTO invoices (
            tenant_id, company_id, sage_id, customer_sage_id, invoice_number,
            reference, date, pre_tax_total, total, balance,
            home_currency_total, home_currency_balance,
            transaction_currency_total, transaction_currency_balance,
            description, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(tenant_id, company_id, sage_id) DO UPDATE SET
            customer_sage_id = excluded.customer_sage_id,
            invoice_number = excluded.invoice_number,
            reference = excluded.reference,
            date = excluded.date,
            pre_tax_total = excluded.pre_tax_total,
            total = excluded.total,
            balance = excluded.balance,
            home_currency_total = excluded.home_currency_total,
            home_currency_balance = excluded.home_currency_balance,
            transaction_currency_total = excluded.transaction_currency_total,
            transaction_currency_balance = excluded.transaction_currency_balance,
            description = excluded.description,
            last_synced_at = CURRENT_TIMESTAMP
        `).bind(
          TenantId,
          CompanyId,
          invoice.Id,
          invoice.CustomerId || null,
          invoice.InvoiceNumber,
          invoice.Reference || null,
          invoice.Date,
          invoice.PreTaxTotal ?? null,
          invoice.Total ?? null,
          invoice.Balance ?? null,
          invoice.HomeCurrencyTotal ?? null,
          invoice.HomeCurrencyBalance ?? null,
          invoice.TransactionCurrencyTotal ?? null,
          invoice.TransactionCurrencyBalance ?? null,
          invoice.Description ?? null
        ).run();
        
        synced++;
      } catch (error) {
        console.error('Failed to sync invoice:', invoice.Id, error);
      }
    }

    await env.DB.prepare(`
      INSERT INTO sync_events (tenant_id, company_id, entity_type, records_synced, status)
      VALUES (?, ?, 'invoices', ?, 'success')
    `).bind(TenantId, CompanyId, synced).run();

    return jsonResponse({ success: true, synced, total: Invoices.length });
  } catch (error) {
    return jsonResponse({
      error: 'Sync failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}

export async function handleSyncProducts(request: Request, tenantId: string, companyId: string, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { Products } = body;
    const scopeError = validateSyncScope(body, tenantId, companyId);
    if (scopeError) return jsonResponse({ error: scopeError }, 403);
    const TenantId = tenantId;
    const CompanyId = companyId;

    if (!Array.isArray(Products)) {
      return jsonResponse({ error: 'Missing required fields' }, 400);
    }

    let synced = 0;

    for (const product of Products) {
      try {
        await env.DB.prepare(`
          INSERT INTO products (
            tenant_id, company_id, sage_id, sku, name, description, unit, price,
            stock, reorder_level, category, is_service, status, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(tenant_id, company_id, sage_id) DO UPDATE SET
            sku = excluded.sku,
            name = excluded.name,
            description = excluded.description,
            unit = excluded.unit,
            price = excluded.price,
            stock = excluded.stock,
            reorder_level = excluded.reorder_level,
            category = excluded.category,
            is_service = excluded.is_service,
            status = excluded.status,
            last_synced_at = CURRENT_TIMESTAMP
        `).bind(
          TenantId,
          CompanyId,
          product.Id,
          product.SKU,
          product.Name,
          product.Description ?? null,
          product.Unit ?? null,
          product.Price ?? null,
          product.Stock ?? null,
          product.ReorderLevel ?? null,
          product.Category ?? null,
          product.IsService ?? null,
          product.Status ?? null
        ).run();
        
        synced++;
      } catch (error) {
        console.error('Failed to sync product:', product.Id, error);
      }
    }

    await env.DB.prepare(`
      INSERT INTO sync_events (tenant_id, company_id, entity_type, records_synced, status)
      VALUES (?, ?, 'products', ?, 'success')
    `).bind(TenantId, CompanyId, synced).run();

    return jsonResponse({ success: true, synced, total: Products.length });
  } catch (error) {
    return jsonResponse({
      error: 'Sync failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
}
