import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { signCapability, verifyCapability } from '../benchmarks/capability';

test('experiment capabilities reject changed claims, expired access and invalid signatures', async () => {
  const secret = 'private-test-secret-'.repeat(4);
  const claims = { id: randomUUID(), role: 'reader' as const, expiresAt: Date.now() + 60_000 };
  const token = await signCapability(secret, claims);
  assert.deepEqual(await verifyCapability(secret, token), claims);
  assert.equal(await verifyCapability(secret + 'changed', token), null);
  assert.equal(await verifyCapability(secret, token + '.extra'), null);
  assert.equal(await verifyCapability(secret, await signCapability(secret, { ...claims, expiresAt: Date.now() - 1 })), null);
  const altered = Buffer.from(JSON.stringify({ ...claims, role: 'writer' })).toString('base64url') + '.' + token.split('.')[1];
  assert.equal(await verifyCapability(secret, altered), null);
  assert.equal(await verifyCapability(secret, 'not.a.valid-capability'), null);
});
