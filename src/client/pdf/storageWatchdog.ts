/**
 * IndexedDB requests can remain pending forever (e.g. a blocked open, stalled
 * storage transaction, or a suspended browser). Bound only the waiting time:
 * abort a still-active transaction on expiry and let its caller back off.
 * A deadline is NOT proof that the stored bytes are missing.
 */
export function withStorageDeadline<T>(
  pending: Promise<T>, operation: string, timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* Timeout still releases the caller. */ }
      reject(new Error(operation + ' timed out'));
    }, timeoutMs);
    pending.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
