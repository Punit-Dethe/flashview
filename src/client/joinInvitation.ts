export type JoinInvitation = { credential: string; code: string; entered?: boolean; name?: string; resumeToken?: string };
const credentialPattern = /^(?:\d{6}(?:\.[A-Za-z0-9_-]{16,128})?|[A-Za-z0-9_-]{16,128})$/;
const historyKey = 'warpviewJoin';

export function invitationFor(credential: string, codeHint = ''): JoinInvitation | null {
  const value = credential.trim();
  if (!credentialPattern.test(value)) return null;
  const code = /^\d{6}(?=\.|$)/.exec(value)?.[0] ?? '';
  if (code && codeHint && code !== codeHint) return null;
  return { credential: value, code: code || (/^\d{6}$/.test(codeHint) ? codeHint : '') };
}

/** Fresh QR/query credentials always start at the name choice. Only the same
 * cleaned history entry can restore a previously entered private session. */
export function readInvitation(url: URL, state: unknown): JoinInvitation | null {
  const legacy = url.searchParams.get('join');
  if (legacy) return invitationFor(legacy);
  const path = /^\/join(?:\/(\d{6}))?\/?$/.exec(url.pathname);
  if (!path) return null;
  const code = path[1] ?? '';
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (fragment.has('invite')) {
    return invitationFor(fragment.get('invite') ?? '', code);
  }
  const stored = state && typeof state === 'object' ? (state as Record<string, unknown>)[historyKey] : undefined;
  if (stored && typeof stored === 'object') {
    const saved = stored as Partial<JoinInvitation>;
    const invitation = typeof saved.credential === 'string' ? invitationFor(saved.credential, code) : null;
    const resumeToken = typeof saved.resumeToken === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(saved.resumeToken) ? saved.resumeToken : undefined;
    if (invitation && saved.code === code) return { ...invitation,
      entered: saved.entered === true && Boolean(resumeToken),
      name: typeof saved.name === 'string' ? saved.name.slice(0, 32) : '', resumeToken };
  }
  return code ? invitationFor(code) : null;
}

export function invitationUrl(origin: string, credential: string, code = ''): string {
  const invitation = invitationFor(credential, code);
  if (!invitation) throw Error('Invalid room invitation');
  const url = new URL('/join' + (invitation.code ? '/' + invitation.code : ''), origin);
  if (invitation.credential !== invitation.code) url.hash = new URLSearchParams({ invite: invitation.credential }).toString();
  return url.href;
}

export function rememberInvitation(invitation: JoinInvitation): void {
  const url = new URL(window.location.href);
  url.pathname = '/join' + (invitation.code ? '/' + invitation.code : ''); url.searchParams.delete('join'); url.hash = '';
  const state = window.history.state;
  // The invitation remains available on refresh without appearing in the URL
  // or being sent in a path/query to the server. Leave clears this entry.
  window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), [historyKey]: invitation }, '', url.pathname + url.search);
}
