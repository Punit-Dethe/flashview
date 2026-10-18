/** Remove expired in-flight relay metadata BEFORE applying the capacity limit.
 * Otherwise 48 stale requests can permanently reject every new retry.
 * No file bytes or sender identifiers are stored here.
 */
export function pruneExpiredRanges<T extends { created: number }>(
  ranges: Map<string, T>, now: number, timeoutMs: number,
): string[] {
  const expired: string[] = [];
  for (const [id, pending] of ranges) {
    if (now - pending.created >= timeoutMs) {
      ranges.delete(id);
      expired.push(id);
    }
  }
  return expired;
}
