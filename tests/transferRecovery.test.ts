import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReconnectForRangeFailure } from '../src/client/pdf/transferRecovery';

test('only a locally unanswered range permits global room socket recovery', () => {
  assert.equal(shouldReconnectForRangeFailure(new Error('PDF range request timed out')), true);
  for (const message of [
    'Receiver relay is temporarily overloaded', 'Sender is offline',
    'Invalid or unavailable file range', 'File is no longer available',
    'Network sender is busy', 'Connection closed', 'Request timed out',
  ]) {
    assert.equal(shouldReconnectForRangeFailure(new Error(message)), false, message);
  }
});
