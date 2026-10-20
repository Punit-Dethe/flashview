import { decodeRangePacket, encodeRangePacket } from '../shared/protocol';
import { perf } from './perf';

export type ServerMessage = { type: string; [key: string]: unknown };
export type SocketStatus = 'disconnected' | 'connecting' | 'connected';
type RangeCallbacks = {
  fileId: string;
  begin: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (begin: number, bytes: Uint8Array) => void;
  reject: (reason: string) => void;
};

/**
 * Session-aware socket. A short network interruption does not erase browser File objects:
 * reconnect authenticates with the existing student resume token.
 */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private identity: Record<string, unknown> | null = null;
  private pending = new Map<string, RangeCallbacks>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private admissionNotBefore = 0;
  private stopped = false;
  private pingSentAt: number | null = null;
  private authenticated = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private openingSince = 0;
  private heartbeatPaused = false;
  private reconnectOnWake = false;
  private foregroundAttempt: WebSocket | null = null;
  // Reversible same-deployment A/B control, like the existing packet/window
  // experiments. No UI setting, identity change, or file-content logging.
  private immediateResume = true;
  private wakeTimeout: ReturnType<typeof setTimeout> | null = null;
  onMessage: (message: ServerMessage) => void = () => {};
  onStatus: (status: SocketStatus) => void = () => {};

  connect(identity: Record<string, unknown>): void {
    this.stopConnection();
    this.stopped = false;
    this.identity = { ...identity };
    this.immediateResume = new URLSearchParams(window.location.search).get('resumePolicy') !== 'probe';
    if (identity.role === 'student' && typeof identity.resumeToken !== 'string') {
      // Know the resume capability before sending hello, so losing the FIRST
      // acknowledgement cannot turn an immediate retry into a second student.
      this.identity.resumeToken = Array.from(crypto.getRandomValues(new Uint8Array(32)),
        byte => byte.toString(16).padStart(2, '0')).join('');
    }
    this.retryCount = 0;
    this.admissionNotBefore = 0;
    this.heartbeatPaused = false;
    this.reconnectOnWake = false;
    this.foregroundAttempt = null;
    this.open();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.pingTimeout !== null) clearTimeout(this.pingTimeout);
    this.pingTimer = null;
    this.pingTimeout = null;
    this.pingSentAt = null;
    if (this.wakeTimeout !== null) clearTimeout(this.wakeTimeout);
    this.wakeTimeout = null;
  }

  /** The system file picker may suspend a mobile webview without a visibility event. */
  pauseHeartbeat(frozen = false): void {
    // A phone picker/background interval can invalidate an apparently OPEN
    // socket. Receiver tab switches alone must not interrupt healthy transfers.
    this.reconnectOnWake ||= frozen || this.identity?.role === 'student';
    this.heartbeatPaused = true;
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.pingTimer !== null || this.heartbeatPaused ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    this.pingTimer = setInterval(() => this.ping(), 25_000);
  }

  private ping(timeoutMs = 12_000): void {
    if (!this.connected || this.pingTimeout !== null || this.heartbeatPaused ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    if (!this.send({ type: 'heartbeat.ping' })) return;
    if (perf.enabled) this.pingSentAt = performance.now();
    this.pingTimeout = setTimeout(() => {
      this.pingTimeout = null;
      if (this.heartbeatPaused ||
          (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        // A half-open TCP connection can appear OPEN until a packet is attempted.
        // Retire it locally: close() can itself wait for a dead network for
        // tens of seconds before onclose fires.
        this.restartStalledTransfer();
      }
    }, timeoutMs);
  }

  /** Call when returning from another tab or when internet access resumes. */
  wake(reason: 'focus' | 'online' = 'focus'): void {
    if (this.stopped || !this.identity) return;
    const suspended = this.reconnectOnWake;
    this.reconnectOnWake = false;
    this.heartbeatPaused = false;
    if (Date.now() < this.admissionNotBefore) { this.scheduleReconnect(); return; }
    if (this.immediateResume && (suspended || reason === 'online')) {
      // One new attempt for the return, without a serial old-socket probe.
      // Coalesce online/focus/pageshow/change events against that attempt.
      if (!suspended && this.foregroundAttempt && this.ws === this.foregroundAttempt && !this.authenticated) return;
      this.restartStalledTransfer();
      this.foregroundAttempt = this.ws;
      return;
    }
    if (this.foregroundAttempt && this.ws === this.foregroundAttempt && !this.authenticated) return;
    // pauseHeartbeat already discarded any suspended deadline. Repeated focus,
    // pageshow and file-change events must not postpone the new probe forever.
    this.startHeartbeat();
    if (this.connected) {
      // Re-validate an apparently open connection immediately on foreground return.
      this.ping(2_000);
      return;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      // Some mobile OS resumes leave the original handshake stuck forever.
      if (Date.now() - this.openingSince > 9_000) this.restartStalledTransfer();
      else this.checkResumedHandshake();
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      // OPEN isn't the same as authenticated, but a normal handshake needs
      // a brief chance to finish before foreground focus triggers a restart.
      if (Date.now() - this.openingSince > 9_000)
        this.restartStalledTransfer();
      else this.checkResumedHandshake();
      return;
    }
    // CLOSING is not reusable, even if its close event never arrives.
    this.stopConnection();
    this.retryCount = 0;
    this.open();
  }

  private checkResumedHandshake(): void {
    if (this.wakeTimeout !== null) return;
    const ws = this.ws;
    // A file may be selected before the original join finishes. Give a healthy
    // handshake time to finish, but don't wait its full background deadline.
    this.wakeTimeout = setTimeout(() => {
      this.wakeTimeout = null;
      if (this.ws === ws && !this.authenticated) this.restartStalledTransfer();
    }, 2_000);
  }

  /** Recover a transfer whose first byte never arrived despite retries.
   * This preserves the student/host credentials and reauthenticates the
   * existing room; it is NOT a file re-upload or a second parallel socket.
   * Used only by the receiver's bounded no-progress watchdog.
   */
  restartStalledTransfer(): void {
    if (this.stopped || !this.identity) return;
    if (Date.now() < this.admissionNotBefore) { this.scheduleReconnect(); return; }
    this.stopConnection();
    this.retryCount = 0;
    this.open();
  }

  private open(): void {
    if (this.stopped || !this.identity || this.ws) return;
    if (Date.now() < this.admissionNotBefore) { this.scheduleReconnect(); return; }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const roomCode = typeof this.identity.code === 'string' ? this.identity.code
      : typeof this.identity.joinToken === 'string' ? this.identity.joinToken.split('.')[0]
      : typeof this.identity.roomId === 'string' ? this.identity.roomId : '';
    const suffix = /^\d{6}$/.test(roomCode) ? '?room=' + encodeURIComponent(roomCode) : '';
    const connectStarted = perf.enabled ? performance.now() : 0;
    this.authenticated = false;
    let authenticated = false;
    const ws = new WebSocket(protocol + '//' + window.location.host + '/ws' + suffix);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.openingSince = Date.now();
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING)
        this.retryConnection();
    }, 10_000);
    this.onStatus('connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.connectTimer !== null) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      // Hello must go out before the socket is considered authenticated.
      ws.send(JSON.stringify({ v: 1, type: 'hello', ...this.identity }));
      this.startHeartbeat();
      // A network can finish its TCP handshake without finishing the room
      // handshake. Do not leave the interface connecting forever.
      this.handshakeTimer = setTimeout(() => {
        if (this.ws === ws && !this.authenticated && ws.readyState === WebSocket.OPEN)
          this.retryConnection();
      }, 10_000);
    };
    ws.onmessage = event => {
      if (this.ws !== ws) return;
      if (typeof event.data === 'string') {
        try {
          const message: ServerMessage = JSON.parse(event.data);
          if (!this.authenticated && message.type === 'error' && message.code === 'JOIN_RATE_LIMIT' &&
              message.retryable === true && typeof message.retryAfterMs === 'number' &&
              Number.isFinite(message.retryAfterMs) && message.retryAfterMs > 0)
            this.admissionNotBefore = Date.now() + Math.min(message.retryAfterMs, 60_000);
          if (message.type === 'heartbeat.pong') {
            if (this.pingSentAt !== null) perf.record('heartbeat_rtt_ms', performance.now() - this.pingSentAt);
            this.pingSentAt = null;
            if (this.pingTimeout !== null) clearTimeout(this.pingTimeout);
            this.pingTimeout = null;
            return;
          }
          if (message.type === 'join.pending' || message.type === 'join.accepted' ||
              message.type === 'join.resumed') {
            if (typeof message.resumeToken === 'string' && this.identity) {
              this.identity.resumeToken = message.resumeToken;
            }
          }
          if (message.type === 'room.state' || message.type === 'join.pending' ||
              message.type === 'join.accepted' || message.type === 'join.resumed') {
            if (!authenticated && perf.enabled) {
              authenticated = true;
              perf.record('socket_connect_ms', performance.now() - connectStarted);
            }
            const wasAuthenticated = this.authenticated;
            this.retryCount = 0;
            this.authenticated = true;
            this.admissionNotBefore = 0;
            if (this.wakeTimeout !== null) clearTimeout(this.wakeTimeout);
            this.wakeTimeout = null;
            if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
            if (!wasAuthenticated) this.onStatus('connected');
          }
          if (message.type === 'room.closed' || message.type === 'join.rejected') {
            // Do not endlessly reconnect to a session that has been closed or rejected.
            this.stopped = true;
          }
          if (message.type === 'range.error' && typeof message.requestId === 'string') {
            const pending = this.pending.get(message.requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(message.requestId);
              pending.reject(String(message.message ?? 'Range request failed'));
            }
          }
          this.onMessage(message);
        } catch {
          this.onMessage({ type: 'error', message: 'Unreadable server response' });
        }
      } else if (event.data instanceof ArrayBuffer) {
        try {
          const { header, bytes } = decodeRangePacket(event.data);
          const pending = this.pending.get(header.requestId);
          if (pending && pending.fileId === header.fileId && pending.begin === header.begin) {
            clearTimeout(pending.timer);
            this.pending.delete(header.requestId);
            pending.resolve(header.begin, bytes.slice());
          }
        } catch { /* Drop malformed binary frames. */ }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authenticated = false;
      if (this.connectTimer !== null) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.stopHeartbeat();
      this.failAll('Connection interrupted; retry the page if necessary');
      this.onStatus('disconnected');
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws === ws) this.onMessage({ type: 'connection.notice', message: 'Network connection interrupted. Retrying automatically.' });
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.identity || this.reconnectTimer !== null) return;
    // Exponential backoff prevents a network outage from hammering free-tier quotas.
    const remaining = this.admissionNotBefore - Date.now();
    const delayMs = remaining > 0 ? remaining : Math.min(750 * 2 ** Math.min(this.retryCount++, 5), 15_000)
      + Math.floor(Math.random() * 300);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delayMs);
  }

  private retryConnection(): void {
    this.stopConnection();
    this.onStatus('disconnected');
    if (!this.stopped) this.scheduleReconnect();
  }

  get connected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  send(message: Record<string, unknown>): boolean {
    if (!this.connected) return false;
    try {
      this.ws!.send(JSON.stringify({ v: 1, ...message }));
      return true;
    } catch {
      this.retryConnection();
      return false;
    }
  }

  /** A response belongs to the connection that requested it, including async reads. */
  rangeResponse(requestId: string, fileId: string, begin: number): {
    send: (bytes: ArrayBuffer) => Promise<boolean>;
    fail: (message: string) => void;
  } {
    const ws = this.ws;
    const current = () => ws !== null && this.ws === ws && this.connected;
    return {
      send: bytes => current()
        ? this.sendBytesWhenReady(requestId, fileId, begin, bytes)
        : Promise.resolve(false),
      fail: message => {
        if (current()) this.send({ type: 'range.error', requestId, message });
      },
    };
  }

  /**
   * Stage 1: backpressure-aware response sender. A temporarily congested
   * browser WebSocket must NOT cause an immediate range.error and 4.5-second
   * retry. Wait for the existing queue to drain, without ever accumulating
   * an unbounded userspace send queue or sending after a reconnect.
   */
  async sendBytesWhenReady(
    requestId: string, fileId: string, begin: number, bytes: ArrayBuffer,
  ): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const packet = encodeRangePacket({ type: 'range.data', requestId, fileId, begin }, bytes);
    const maxBuffered = 4 * 1024 * 1024;
    const started = performance.now();
    while (this.ws === ws && ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount + packet.byteLength <= maxBuffered) {
        try {
          ws.send(packet);
          if (perf.enabled && performance.now() - started > 2)
            perf.record('sender_backpressure_ms', performance.now() - started);
          return true;
        } catch { return false; }
      }
      // Deliberately shorter than the server's 20-second range timeout.
      if (performance.now() - started >= 6500) {
        if (perf.enabled)
          perf.record('sender_backpressure_ms', performance.now() - started, { outcome: 'error' });
        return false;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 45));
    }
    return false;
  }

  requestRange(
    fileId: string, begin: number, end: number,
    resolve: (start: number, data: Uint8Array) => void, reject: (message: string) => void,
  ): () => void {
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const started = perf.enabled ? performance.now() : 0;
    const successful = (start: number, data: Uint8Array) => {
      if (perf.enabled) perf.record('range_roundtrip_ms', performance.now() - started, { bytes: data.byteLength });
      resolve(start, data);
    };
    const unsuccessful = (message: string) => {
      if (perf.enabled) perf.record('range_roundtrip_ms', performance.now() - started, { outcome: 'error' });
      reject(message);
    };
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      unsuccessful('PDF range request timed out');
    }, 25_000);
    this.pending.set(requestId, { fileId, begin, timer, resolve: successful, reject: unsuccessful });
    if (!this.send({ type: 'range.request', requestId, fileId, begin, end })) {
      clearTimeout(timer);
      if (this.pending.delete(requestId)) unsuccessful('Not connected');
    }
    return () => {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        this.send({ type: 'range.cancel', requestId });
      }
    };
  }

  private failAll(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(message);
    }
    this.pending.clear();
  }

  private stopConnection(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.authenticated = false;
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.failAll('Connection closed');
    const old = this.ws;
    this.ws = null;
    if (old?.readyState === WebSocket.CONNECTING) {
      // Abort an obsolete handshake now rather than leaving another live
      // connection attempt behind every timeout. Tolerate unusual webviews.
      try { old.close(); }
      catch { old.addEventListener('open', () => old.close(), { once: true }); }
    } else if (old && old.readyState === WebSocket.OPEN) old.close();
  }

  close(): void {
    this.stopped = true;
    this.admissionNotBefore = 0;
    this.identity = null;
    this.stopConnection();
    this.onStatus('disconnected');
  }
}
