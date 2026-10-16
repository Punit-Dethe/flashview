/**
 * FlashView Performance 2.0 / Stage 1: conservative AIMD-style transfer window.
 * Pure logic for deterministic testing. All sizes remain canonical 64 KiB.
 *
 * A per-file window grows slowly after a train of healthy range responses,
 * but falls quickly on failed or substantially slower requests. A cap protects
 * the host relay, phone RAM, and the foreground viewer's independent requests.
 */
export const WINDOW_MIN = 2;
export const WINDOW_INITIAL = 6;
export const WINDOW_MAX = 10;

export class AdaptiveTransferWindow {
  private slots = WINDOW_INITIAL;
  private successful = 0;
  private bestMs = Number.POSITIVE_INFINITY;
  private smoothedMs = 0;
  private recovery = 0;
  get limit(): number { return this.slots; }
  get rttMs(): number { return this.smoothedMs; }

  success(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
    const ms = Math.max(1, elapsedMs);
    this.bestMs = Math.min(this.bestMs, ms);
    this.smoothedMs = this.smoothedMs === 0 ? ms : (this.smoothedMs * .85 + ms * .15);
    // Use a floor to avoid reacting to the normal noise of localhost tests.
    const baseline = Math.max(12, this.bestMs);
    if (ms <= baseline * 1.4) {
      // When the sender becomes fast again, the old congestion EWMA must not
      // cause a second backoff from otherwise healthy responses.
      this.smoothedMs = Math.min(this.smoothedMs, baseline * 1.4);
    }
    if (this.recovery > 0) { this.recovery--; return; }
    if (this.smoothedMs > baseline * 2.2 && this.slots > WINDOW_MIN) {
      this.slots = Math.max(WINDOW_MIN, Math.ceil(this.slots / 2));
      this.successful = 0;
      this.recovery = 12;
      return;
    }
    this.successful++;
    if (this.successful >= 12) {
      this.successful = 0;
      this.slots = Math.min(WINDOW_MAX, this.slots + 1);
    }
  }
  failure(): void {
    this.slots = Math.max(WINDOW_MIN, Math.ceil(this.slots / 2));
    this.successful = 0;
    this.recovery = 12;
  }
}
