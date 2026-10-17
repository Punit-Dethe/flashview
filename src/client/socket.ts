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
type StreamCallbacks = {
  fileId: string; next: number; end: number; committedSinceCredit: number;
  timer: ReturnType<typeof setTimeout>;
  processing: Promise<void>;
  onData: (begin: number, data: Uint8Array) => Promise<void>;
  resolve: () => void; reject: (reason: string) => void;
};

/**
 * Session-aware socket. A short network interruption does not erase browser File objects:
 * reconnect authenticates with the existing student resume token.
 */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private identity: Record<string, unknown> | null = null;
  private pending = new Map<string, RangeCallbacks>();
  private streams = new Map<string, StreamCallbacks>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private stopped = false;
  private pingSentAt: number | null = null;
  private authenticated = false;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private openingSince = 0;
  private heartbeatPaused = false;
  onMessage: (message: ServerMessage) => void = () => {};
  onStatus: (status: SocketStatus) => void = () => {};

  connect(identity: Record<string, unknown>): void {
    this.stopConnection();
    this.stopped = false;
    this.identity = { ...identity };
    this.retryCount = 0;
    this.heartbeatPaused = false;
    this.open();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.pingTimeout !== null) clearTimeout(this.pingTimeout);
    this.pingTimer = null;
    this.pingTimeout = null;
    this.pingSentAt = null;
  }

  /** The system file picker may suspend a mobile webview without a visibility event. */
  pauseHeartbeat(): void {
    this.heartbeatPaused = true;
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.pingTimer !== null || this.heartbeatPaused ||
        (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    this.pingTimer = setInterval(() => this.ping(), 25_000);
  }

  private ping(): void {
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
        this.ws.close(4001, 'Heartbeat timeout');
      }
    }, 12_000);
  }

  /** Call when returning from another tab or when internet access resumes. */
  wake(): void {
    if (this.stopped || !this.identity) return;
    this.heartbeatPaused = false;
    // Discard an old deadline from a suspended file picker or background tab.
    if (this.pingTimeout !== null) clearTimeout(this.pingTimeout);
    this.pingTimeout = null;
    this.startHeartbeat();
    if (this.connected) {
      // Re-validate an apparently open connection immediately on foreground return.
      this.ping();
      return;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      // Some mobile OS resumes leave the original handshake stuck forever.
      if (Date.now() - this.openingSince > 9_000) this.ws.close();
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      // OPEN isn't the same as authenticated, but a normal handshake needs
      // a brief chance to finish before foreground focus triggers a restart.
      if (Date.now() - this.openingSince > 9_000)
        this.ws.close(4002, 'Authentication stalled');
      return;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.open();
  }

  private open(): void {
    if (this.stopped || !this.identity || this.ws) return;
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
        ws.close();
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
          ws.close(4002, 'Room handshake timeout');
      }, 10_000);
    };
    ws.onmessage = event => {
      if (this.ws !== ws) return;
      if (typeof event.data === 'string') {
        try {
          const message: ServerMessage = JSON.parse(event.data);
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
            this.retryCount = 0;
            this.authenticated = true;
            if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
            this.onStatus('connected');
          }
          if (message.type === 'room.closed' || message.type === 'join.rejected') {
            // Do not endlessly reconnect to a session that has been closed or rejected.
            this.stopped = true;
          }
          if (message.type === 'stream.error' && typeof message.streamId === 'string') {
            this.failStream(message.streamId, String(message.message ?? 'Stream interrupted'));
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
          if (header.type === 'stream.data') {
            const id = header.requestId;
            const state = this.streams.get(id);
            if (!state || state.fileId !== header.fileId) return;
            const piece = bytes.slice();
            this.refreshStreamTimer(id, state);
            // Serialize IndexedDB commits, even if later frames arrive before
            // the first transaction completes. Credits follow durable commits.
            state.processing = state.processing.then(async () => {
              if (this.streams.get(id) !== state) return;
              if (header.begin !== state.next ||
                  piece.byteLength !== Math.min(256 * 1024, state.end - state.next)) {
                this.failStream(id, 'Out-of-order stream frame'); return;
              }
              await state.onData(header.begin, piece);
              if (this.streams.get(id) !== state) return;
              state.next += piece.byteLength;
              if (state.next === state.end) {
                clearTimeout(state.timer);
                this.streams.delete(id);
                state.resolve();
              } else if (++state.committedSinceCredit >= 4) {
                state.committedSinceCredit = 0;
                if (!this.send({type:'stream.credit',streamId:id,credits:4}))
                  this.failStream(id, 'Stream connection interrupted');
              }
            }).catch(error => this.failStream(id, String(error)));
            return;
          }
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
    const delayMs = Math.min(750 * 2 ** Math.min(this.retryCount++, 5), 15_000)
      + Math.floor(Math.random() * 300);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delayMs);
  }

  get connected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  send(message: Record<string, unknown>): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify({ v: 1, ...message }));
    return true;
  }

  /**
   * Stage 1: backpressure-aware response sender. A temporarily congested
   * browser WebSocket must NOT cause an immediate range.error and 4.5-second
   * retry. Wait for the existing queue to drain, without ever accumulating
   * an unbounded userspace send queue or sending after a reconnect.
   */
  async sendBytesWhenReady(
    requestId: string, fileId: string, begin: number, bytes: ArrayBuffer,
    type: 'range.data' | 'stream.data' = 'range.data',
  ): Promise<boolean> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const packet = encodeRangePacket({ type, requestId, fileId, begin }, bytes);
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
      this.pending.delete(requestId);
      unsuccessful('Not connected');
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

  /**
   * Phase 3 experiment: one authorized contiguous stream; four frames of
   * bounded credit. Only committed IndexedDB blocks replenish the sender.
   */
  openStream(
    fileId: string, begin: number, end: number,
    onData: (begin: number, data: Uint8Array) => Promise<void>,
  ): {done: Promise<void>; cancel: () => void} {
    const streamId = crypto.randomUUID().replaceAll('-', '');
    let resolve!: () => void;
    let reject!: (message: string) => void;
    const done = new Promise<void>((ok, bad) => {
      resolve = ok; reject = bad;
    });
    const state: StreamCallbacks = {
      fileId, next: begin, end, committedSinceCredit: 0, onData, resolve,
      reject, processing: Promise.resolve(),
      timer: setTimeout(() => this.failStream(streamId, 'Stream stalled'), 25_000),
    };
    this.streams.set(streamId, state);
    if (!this.send({type:'stream.open',streamId,fileId,begin,end})) {
      this.failStream(streamId, 'Sender is offline');
    }
    return {done, cancel: () => this.failStream(streamId, 'Stream cancelled')};
  }

  private refreshStreamTimer(id: string, state: StreamCallbacks): void {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => this.failStream(id, 'Stream stalled'), 25_000);
  }
  private failStream(id: string, reason: string): void {
    const state = this.streams.get(id);
    if (!state) return;
    clearTimeout(state.timer);
    this.streams.delete(id);
    this.send({ type: 'stream.stop', streamId: id });
    state.reject(reason);
  }

  private failAll(message: string): void {
    for (const id of [...this.streams.keys()]) this.failStream(id, message);
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
      // Avoid InvalidStateError if a user leaves while handshake is in progress.
      old.addEventListener('open', () => old.close(), { once: true });
    } else if (old && old.readyState === WebSocket.OPEN) old.close();
  }

  close(): void {
    this.stopped = true;
    this.identity = null;
    this.stopConnection();
    this.onStatus('disconnected');
  }
}
