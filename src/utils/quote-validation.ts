export interface QuoteLineInput {
  sku?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
}

export interface QuoteInput {
  customerId?: unknown;
  lines?: unknown;
}

export type InvoiceInput = QuoteInput;

export function validateDocumentPayload(kind: 'quote' | 'invoice', document: QuoteInput): string | null {
  const prefix = `${kind}.`;
  if (!document || typeof document.customerId !== 'string' || !document.customerId.trim()) {
    return `${prefix}customerId is required`;
  }
  if (!Array.isArray(document.lines) || document.lines.length === 0) {
    return `${prefix}lines must contain at least one item`;
  }
  if (document.lines.length > 100) {
    return `${prefix}lines cannot contain more than 100 items`;
  }
  for (let index = 0; index < document.lines.length; index++) {
    const line = document.lines[index] as QuoteLineInput;
    if (!line || typeof line.sku !== 'string' || !line.sku.trim()) {
      return `${prefix}lines[${index}].sku is required`;
    }
    if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
      return `${prefix}lines[${index}].quantity must be greater than 0`;
    }
    if (typeof line.unitPrice !== 'number' || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      return `${prefix}lines[${index}].unitPrice must be 0 or greater`;
    }
  }
  return null;
}

export function validateQuotePayload(quote: QuoteInput): string | null {
  return validateDocumentPayload('quote', quote);
}

export function validateInvoicePayload(invoice: InvoiceInput): string | null {
  return validateDocumentPayload('invoice', invoice);
}
