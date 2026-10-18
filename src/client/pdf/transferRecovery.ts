/** Only a locally timed-out unanswered byte request suggests a half-open
 * receiver/relay connection. A prompt range.error proves that the socket is
 * alive; restarting it would interrupt every other sender needlessly.
 */
export function shouldReconnectForRangeFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message === 'PDF range request timed out';
}
