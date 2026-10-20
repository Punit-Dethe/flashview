import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationFor, invitationUrl, readInvitation } from '../src/client/joinInvitation';

test('clean invitations preserve both relay token formats without a token in the request URL', () => {
  for (const token of ['123456.' + 'a'.repeat(48), 'n'.repeat(27)]) {
    const url = new URL(invitationUrl('https://warpview.net', token, '123456'));
    assert.equal(url.pathname, '/join/123456'); assert.equal(url.search, '');
    assert.equal(readInvitation(url, null)?.credential, token);
    assert.equal(readInvitation(url, null)?.code, '123456');
    assert.equal(url.pathname.includes(token), false);
  }
  assert.equal(invitationUrl('https://warpview.net', '012345'), 'https://warpview.net/join/012345');
});

test('legacy opaque and code-prefixed QR links still open the name choice', () => {
  for (const token of ['123456.' + 'a'.repeat(48), 'n'.repeat(27), '012345']) {
    const result = readInvitation(new URL('https://warpview.net/?join=' + token), null);
    assert.equal(result?.credential, token); assert.equal(result?.entered, undefined);
  }
  assert.equal(invitationFor('123456')?.code, '123456');
  assert.equal(invitationFor('not a room'), null);
  assert.equal(readInvitation(new URL('https://warpview.net/join/123456#invite=654321.' + 'a'.repeat(48)), null), null);
  assert.equal(readInvitation(new URL('https://warpview.net/join/123456#invite='), null), null, 'An invalid supplied token must not downgrade to code admission');
});

test('only matching history entries with private resume credentials bypass the name choice', () => {
  const invitation = { credential: 'n'.repeat(27), code: '123456', entered: true, name: 'Asha', resumeToken: 'a'.repeat(64) };
  const state = { warpviewJoin: invitation };
  const url = new URL('https://warpview.net/join/123456');
  assert.equal(readInvitation(url, state)?.entered, true);
  assert.equal(readInvitation(url, state)?.name, 'Asha');
  assert.equal(readInvitation(new URL('https://warpview.net/join/654321'), state)?.credential, '654321');
  assert.equal(readInvitation(url, { warpviewJoin: { ...invitation, resumeToken: undefined } })?.entered, false);
  const fresh = new URL(invitationUrl(url.origin, invitation.credential, invitation.code));
  assert.equal(readInvitation(fresh, state)?.entered, undefined, 'A new scan must not inherit an earlier choice');
  assert.equal(readInvitation(new URL('https://warpview.net/'), state), null);
});
