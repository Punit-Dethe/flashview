type GuardNamespace = { getByName(name: string): { fetch(request: Request): Promise<Response> } };

/** During a rolling update an older object may not yet expose the new endpoint. */
export async function checkCreationPermit(source: string, rooms: GuardNamespace):
  Promise<{ mode: 'enforced' | 'legacy'; denial: Response | null }> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const permit = await rooms.getByName('creation:' + key)
    .fetch(new Request('https://internal/creation-permit', { method: 'POST' }));
  // The old class's unknown endpoint is exactly 404. Do not bypass real quota
  // denial, storage/runtime errors or any other status. Keep this compatibility
  // path while rollbacks to the pre-guard class remain supported.
  if (permit.status === 404) return { mode: 'legacy', denial: null };
  return { mode: 'enforced', denial: permit.ok ? null : permit };
}
