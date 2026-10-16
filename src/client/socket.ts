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

export class RoomSocket {
  private ws: WebSocket | null = null;
  private pending = new Map<string, RangeCallbacks>();
  onMessage: (message: ServerMessage) => void = () => {};
  onStatus: (status: SocketStatus) => void = () => {};

  connect(identity: Record<string, unknown>): void {
    this.close();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(protocol + '//' + window.location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.onStatus('connecting');
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.onStatus('connected');
      this.send({ type: 'hello', ...identity });
    };
    ws.onmessage = event => {
      if (this.ws !== ws) return;
      if (typeof event.data === 'string') {
        try {
          const message: ServerMessage = JSON.parse(event.data);
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
            // PDF.js takes ownership of Uint8Arrays transferred to its worker.
            pending.resolve(header.begin, bytes.slice());
          }
        } catch { /* Drop malformed binary frames. */ }
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.failAll('Connection lost');
        this.onStatus('disconnected');
      }
    };
    ws.onerror = () => {
      if (this.ws === ws) this.onMessage({ type: 'error', message: 'Connection error. Check network access.' });
    };
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

  close(): void {
    this.failAll('Connection closed');
    const previous = this.ws;
    this.ws = null;
    previous?.close();
  }
}
