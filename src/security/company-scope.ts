export type CompanyLookup = {
  id: string;
  tenantId: string;
};

export type CompanySelectionResult =
  | { ok: true; companyId: string }
  | { ok: false; status: number; error: string };

export function validateCompanySelection(
  tenantId: string,
  requestedCompanyId: string | null,
  company: CompanyLookup | null
): CompanySelectionResult {
  if (!requestedCompanyId) {
    return {
      ok: false,
      status: 400,
      error: 'X-Company-Id is required for connector requests'
    };
  }

  if (!company || company.id !== requestedCompanyId || company.tenantId !== tenantId) {
    return {
      ok: false,
      status: 403,
      error: 'Company is not authorized for this tenant'
    };
  }

  return { ok: true, companyId: requestedCompanyId };
}

export function validateSyncScope(
  body: { TenantId?: unknown; CompanyId?: unknown },
  tenantId: string,
  companyId: string
): string | null {
  if (body.TenantId !== tenantId || body.CompanyId !== companyId) {
    return 'Sync payload scope does not match authenticated tenant/company scope';
  }
  return null;
}

/**
 * Tenant-scoped routes operate on the tenant, not a single company, so they
 * must NOT require an X-Company-Id selection. Company registration and listing
 * are the bootstrap path: a tenant with no companies yet still has to reach
 * them. Every data route stays company-scoped.
 */
export function isTenantScopedRoute(path: string, method: string): boolean {
  return path === '/api/companies' && (method === 'GET' || method === 'POST');
}
