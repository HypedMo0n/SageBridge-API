import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuotePayload } from '../src/utils/quote-validation.ts';

test('accepts a quote containing existing Sage item SKUs', () => {
  assert.deepEqual(validateQuotePayload({
    customerId: '33',
    lines: [
      { sku: 'S1040', quantity: 2, unitPrice: 150 },
      { sku: 'S2015', quantity: 1, unitPrice: 85.5 }
    ]
  }), null);
});

test('rejects description-only quote lines', () => {
  assert.equal(validateQuotePayload({
    customerId: '33', lines: [{ description: 'Consulting', quantity: 1, unitPrice: 100 }]
  }), 'quote.lines[0].sku is required');
});

test('rejects invalid quantities and prices', () => {
  assert.equal(validateQuotePayload({
    customerId: '33', lines: [{ sku: 'S1040', quantity: 0, unitPrice: 100 }]
  }), 'quote.lines[0].quantity must be greater than 0');
  assert.equal(validateQuotePayload({
    customerId: '33', lines: [{ sku: 'S1040', quantity: 1, unitPrice: -1 }]
  }), 'quote.lines[0].unitPrice must be 0 or greater');
});

test('rejects missing customer and empty line list', () => {
  assert.equal(validateQuotePayload({ customerId: '', lines: [] }), 'quote.customerId is required');
  assert.equal(validateQuotePayload({ customerId: '33', lines: [] }), 'quote.lines must contain at least one item');
});
