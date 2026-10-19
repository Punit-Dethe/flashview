/** Confirm repeated browser QuotaExceededError before pausing a file. */
export const MAX_QUOTA_FAILURES = 3;
export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as {name?:unknown}).name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
export function quotaExhausted(error: unknown, consecutiveFailures: number): boolean {
  return isQuotaError(error) && consecutiveFailures >= MAX_QUOTA_FAILURES;
}
