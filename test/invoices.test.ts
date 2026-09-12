import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInvoicePayload } from '../src/utils/invoice-validation.ts';

test('accepts an invoice containing existing Sage item SKUs', () => {
  assert.deepEqual(validateInvoicePayload({
    customerId: '33',
    lines: [
      { sku: 'S1040', quantity: 2, unitPrice: 150 },
      { sku: 'S2015', quantity: 1, unitPrice: 85.5 }
    ]
  }), null);
});

test('rejects description-only invoice lines', () => {
  assert.equal(validateInvoicePayload({
    customerId: '33', lines: [{ description: 'Consulting', quantity: 1, unitPrice: 100 }]
  }), 'invoice.lines[0].sku is required');
});

test('rejects invalid quantities and prices', () => {
  assert.equal(validateInvoicePayload({
    customerId: '33', lines: [{ sku: 'S1040', quantity: 0, unitPrice: 100 }]
  }), 'invoice.lines[0].quantity must be greater than 0');
  assert.equal(validateInvoicePayload({
    customerId: '33', lines: [{ sku: 'S1040', quantity: 1, unitPrice: -1 }]
  }), 'invoice.lines[0].unitPrice must be 0 or greater');
});

test('rejects missing customer and empty line list', () => {
  assert.equal(validateInvoicePayload({ customerId: '', lines: [] }), 'invoice.customerId is required');
  assert.equal(validateInvoicePayload({ customerId: '33', lines: [] }), 'invoice.lines must contain at least one item');
});
