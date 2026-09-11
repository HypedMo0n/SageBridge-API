export interface QuoteLineInput {
  sku?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
}

export interface QuoteInput {
  customerId?: unknown;
  lines?: unknown;
}

export function validateQuotePayload(quote: QuoteInput): string | null {
  if (!quote || typeof quote.customerId !== 'string' || !quote.customerId.trim()) {
    return 'quote.customerId is required';
  }
  if (!Array.isArray(quote.lines) || quote.lines.length === 0) {
    return 'quote.lines must contain at least one item';
  }
  if (quote.lines.length > 100) {
    return 'quote.lines cannot contain more than 100 items';
  }
  for (let index = 0; index < quote.lines.length; index++) {
    const line = quote.lines[index] as QuoteLineInput;
    if (!line || typeof line.sku !== 'string' || !line.sku.trim()) {
      return `quote.lines[${index}].sku is required`;
    }
    if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0) {
      return `quote.lines[${index}].quantity must be greater than 0`;
    }
    if (typeof line.unitPrice !== 'number' || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      return `quote.lines[${index}].unitPrice must be 0 or greater`;
    }
  }
  return null;
}
