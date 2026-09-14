import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { validateCompanySelection, validateSyncScope } from '../src/security/company-scope.ts';

test('connector credential can select another company only inside its tenant', () => {
  assert.deepEqual(
    validateCompanySelection('tenant-a', 'company-b', { id: 'company-b', tenantId: 'tenant-a' }),
    { ok: true, companyId: 'company-b' }
  );
});

test('connector request without explicit company scope is rejected', () => {
  assert.deepEqual(validateCompanySelection('tenant-a', null, null), {
    ok: false,
    status: 400,
    error: 'X-Company-Id is required for connector requests'
  });
});

test('connector cannot select a company outside its tenant', () => {
  assert.deepEqual(
    validateCompanySelection('tenant-a', 'foreign-company', { id: 'foreign-company', tenantId: 'tenant-b' }),
    { ok: false, status: 403, error: 'Company is not authorized for this tenant' }
  );
});

test('sync payload must exactly match the authenticated tenant and company', () => {
  assert.equal(validateSyncScope({ TenantId: 'tenant-a', CompanyId: 'company-b' }, 'tenant-a', 'company-b'), null);
  assert.match(validateSyncScope({ TenantId: 'tenant-a', CompanyId: 'company-a' }, 'tenant-a', 'company-b') ?? '', /scope/i);
  assert.match(validateSyncScope({ TenantId: 'tenant-b', CompanyId: 'company-b' }, 'tenant-a', 'company-b') ?? '', /scope/i);
});

test('connector job payload includes the company ID used to poll it', () => {
  const source = readFileSync(new URL('../src/handlers/connector.ts', import.meta.url), 'utf8');
  assert.match(source, /company_id/);
  assert.match(source, /companyId:\s*row\.company_id/);
});

test('company registration uses a server-generated stable cloud id', () => {
  const companiesSource = readFileSync(new URL('../src/handlers/companies.ts', import.meta.url), 'utf8');
  const routerSource = readFileSync(new URL('../src/router.ts', import.meta.url), 'utf8');
  assert.match(companiesSource, /handleCreateCompany/);
  assert.match(companiesSource, /company_\$\{crypto\.randomUUID\(\)\}/);
  assert.match(companiesSource, /INSERT INTO companies/);
  assert.match(routerSource, /path === '\/api\/companies' && method === 'POST'/);
});

test('company list is tenant scoped and exposed by the router', () => {
  const handler = readFileSync(new URL('../src/handlers/companies.ts', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../src/router.ts', import.meta.url), 'utf8');
  assert.match(handler, /WHERE tenant_id = \?/);
  assert.match(router, /path === '\/api\/companies'/);
});

test('job idempotency is isolated by tenant and company', () => {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/0004_multi_company_scope.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(schema, /request_id TEXT NOT NULL UNIQUE/);
  assert.match(schema, /UNIQUE\(tenant_id, company_id, request_id\)/);
  assert.match(migration, /UNIQUE\(tenant_id, company_id, request_id\)/);
});

test('sync handlers receive authenticated scope instead of trusting only the request body', () => {
  const source = readFileSync(new URL('../src/handlers/sync.ts', import.meta.url), 'utf8');
  assert.match(source, /handleSyncCustomers\(request: Request, tenantId: string, companyId: string, env: Env\)/);
  assert.match(source, /validateSyncScope\(body, tenantId, companyId\)/);
});
