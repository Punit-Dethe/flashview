import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCreationPermit } from '../src/cloudflare/creationPermit';

test('rolling deployment accepts only the legacy missing guard endpoint; quota and storage errors stay enforced', async () => {
  const names: string[] = [];
  for (const status of [404, 200, 429, 500, 503]) {
    const response = new Response(status === 404 ? 'Not found' : '', { status,
      headers: status === 429 ? { 'Retry-After': '60' } : undefined });
    const result = await checkCreationPermit('198.51.100.42', { getByName(name) {
      names.push(name);
      return { async fetch(request) {
        assert.equal(request.method, 'POST'); assert.equal(new URL(request.url).pathname, '/creation-permit');
        return response;
      } };
    } });
    assert.equal(result.mode, status === 404 ? 'legacy' : 'enforced');
    assert.equal(result.denial, status === 404 || status === 200 ? null : response);
    if (result.denial?.status === 429) assert.equal(result.denial.headers.get('Retry-After'), '60');
  }
  assert.equal(new Set(names).size, 1, 'All versions address the same durable source quota');
  assert.match(names[0], /^creation:[a-f0-9]{64}$/);
  assert.equal(names[0].includes('198.51.100.42'), false);
  await assert.rejects(checkCreationPermit('198.51.100.42', { getByName() {
    return { async fetch() { throw Error('Storage unavailable'); } };
  } }), /Storage unavailable/, 'Exceptions must not fall back to unguarded creation');
});
