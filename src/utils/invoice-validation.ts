export interface InvoiceLineInput {
  sku?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
}

export interface InvoiceInput {
  customerId?: unknown;
  lines?: unknown;
}

export function validateInvoicePayload(invoice: InvoiceInput): string | null {
  if (!invoice || typeof invoice.customerId !== 'string' || !invoice.customerId.trim()) {
    return 'invoice.customerId is required';
  }
  if (invoice.customerId.length > 128) {
    return 'invoice.customerId must not exceed 128 characters';
  }
  if (!Array.isArray(invoice.lines) || invoice.lines.length === 0) {
    return 'invoice.lines must contain at least one item';
  }
  if (invoice.lines.length > 100) {
    return 'invoice.lines cannot contain more than 100 items';
  }
  for (let index = 0; index < invoice.lines.length; index++) {
    const line = invoice.lines[index] as InvoiceLineInput;
    if (!line || typeof line.sku !== 'string' || !line.sku.trim()) {
      return `invoice.lines[${index}].sku is required`;
    }
    if (line.sku.length > 128) {
      return `invoice.lines[${index}].sku must not exceed 128 characters`;
    }
    if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
      return `invoice.lines[${index}].quantity must be greater than 0`;
    }
    if (typeof line.unitPrice !== 'number' || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      return `invoice.lines[${index}].unitPrice must be 0 or greater`;
    }
  }
  return null;
}
