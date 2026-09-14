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
