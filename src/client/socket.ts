import { decodeRangePacket, encodeRangePacket } from '../shared/protocol';

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
  private stopped = false;
  onMessage: (message: ServerMessage) => void = () => {};
  onStatus: (status: SocketStatus) => void = () => {};

  connect(identity: Record<string, unknown>): void {
    this.stopConnection();
    this.stopped = false;
    this.identity = { ...identity };
    this.retryCount = 0;
    this.open();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.pingTimeout !== null) clearTimeout(this.pingTimeout);
    this.pingTimer = null;
    this.pingTimeout = null;
  }

  private ping(): void {
    if (!this.connected || this.pingTimeout !== null) return;
    if (!this.send({ type: 'heartbeat.ping' })) return;
    this.pingTimeout = setTimeout(() => {
      this.pingTimeout = null;
      if (this.ws?.readyState === WebSocket.OPEN) {
        // A half-open TCP connection can appear OPEN until a packet is attempted.
        this.ws.close(4001, 'Heartbeat timeout');
      }
    }, 12_000);
  }

  /** Call when returning from another tab or when internet access resumes. */
  wake(): void {
    if (this.stopped || !this.identity) return;
    if (this.connected) {
      // Avoid interpreting a delayed background-tab timer as a server disconnect.
      this.ping();
      return;
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) return;
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
    const ws = new WebSocket(protocol + '//' + window.location.host + '/ws' + suffix);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.onStatus('connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.send({ type: 'hello', ...this.identity });
      this.pingTimer = setInterval(() => this.ping(), 25_000);
    };
    ws.onmessage = event => {
      if (this.ws !== ws) return;
      if (typeof event.data === 'string') {
        try {
          const message: ServerMessage = JSON.parse(event.data);
          if (message.type === 'heartbeat.pong') {
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
            this.retryCount = 0;
            this.onStatus('connected');
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

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  send(message: Record<string, unknown>): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify({ v: 1, ...message }));
    return true;
  }

  sendBytes(requestId: string, fileId: string, begin: number, bytes: ArrayBuffer): boolean {
    if (!this.connected || this.ws!.bufferedAmount > 4 * 1024 * 1024) return false;
    this.ws!.send(encodeRangePacket({ type: 'range.data', requestId, fileId, begin }, bytes));
    return true;
  }

  requestRange(
    fileId: string, begin: number, end: number,
    resolve: (start: number, data: Uint8Array) => void, reject: (message: string) => void,
  ): () => void {
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      reject('PDF range request timed out');
    }, 25_000);
    this.pending.set(requestId, { fileId, begin, timer, resolve, reject });
    if (!this.send({ type: 'range.request', requestId, fileId, begin, end })) {
      clearTimeout(timer);
      this.pending.delete(requestId);
      reject('Not connected');
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
