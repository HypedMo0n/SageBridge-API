import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, payloadFingerprint, isIdempotencyConflict } from '../src/utils/idempotency.ts';

test('canonicalJson is stable across object key order', () => {
  const first = { name: 'Rayan Nair', contact: { phone: '604', email: 'r@example.ca' } };
  const second = { contact: { email: 'r@example.ca', phone: '604' }, name: 'Rayan Nair' };
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test('payloadFingerprint changes when submitted data changes', async () => {
  const first = await payloadFingerprint('customer.create', { name: 'Rayan Nair' });
  const second = await payloadFingerprint('customer.create', { name: 'Another Customer' });
  assert.notEqual(first, second);
});

test('same key is a conflict when action or payload differs', () => {
  assert.equal(isIdempotencyConflict('customer.create', 'abc', 'customer.create', 'abc'), false);
  assert.equal(isIdempotencyConflict('customer.create', 'abc', 'customer.create', 'xyz'), true);
  assert.equal(isIdempotencyConflict('customer.create', 'abc', 'invoice.create', 'abc'), true);
});
