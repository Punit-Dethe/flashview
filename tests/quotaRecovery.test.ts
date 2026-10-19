import test from 'node:test';
import assert from 'node:assert/strict';
import {isQuotaError, quotaExhausted, MAX_QUOTA_FAILURES} from '../src/client/pdf/quotaRecovery';

test('quota errors are distinguished from ordinary failures', () => {
  assert.equal(isQuotaError(new DOMException('full','QuotaExceededError')), true);
  assert.equal(isQuotaError({name:'NS_ERROR_DOM_QUOTA_REACHED'}), true);
  assert.equal(isQuotaError(new Error('storage timeout')), false);
  assert.equal(isQuotaError(null), false);
});
test('persistent quota failures stop automatic retries after three consecutive errors', () => {
  const full = new DOMException('full','QuotaExceededError');
  assert.equal(MAX_QUOTA_FAILURES, 3);
  assert.equal(quotaExhausted(full, 1), false);
  assert.equal(quotaExhausted(full, 2), false);
  assert.equal(quotaExhausted(full, 3), true);
  assert.equal(quotaExhausted(new Error('timeout'), 100), false);
});
