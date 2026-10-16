import { DurableObject } from 'cloudflare:workers';
import {
  MAX_PDF_BYTES, MAX_RANGE_BYTES, ROOM_TTL_MS, RANGE_TIMEOUT_MS,
  decodeRangePacket, type PdfManifest, type StudentInfo,
} from '../shared/protocol';

interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}
type Role = 'host' | 'student' | null;
interface Peer { id: string; role: Role; name: string; approved: boolean }
interface RoomConfig { code: string; hostToken: string; joinToken: string; created: number }
interface RangeRequest { fileId: string; senderId: string; begin: number; end: number; created: number }
const MAX_STUDENTS = 30;
const OPEN = 1;
function token(size = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function cleanText(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{6,80}$/.test(value);
}
function send(ws: WebSocket | null, message: Record<string, unknown>): void {
  if (ws && ws.readyState === OPEN) ws.send(JSON.stringify({ v: 1, ...message }));
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

/**
 * Every classroom maps deterministically to one SQLite-backed, hibernatable Durable Object.
 * The object persists only short-lived room tokens and manifests; no PDF byte content.
 */
export class ClassroomRoom extends DurableObject<Env> {
  private peers = new Map<WebSocket, Peer>();
  private config: RoomConfig | null = null;
  private files = new Map<string, PdfManifest>();
  // Deliberately volatile: a hibernation race is retried by the client's range timeout.
  private ranges = new Map<string, RangeRequest>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const ws of ctx.getWebSockets()) {
      const peer = ws.deserializeAttachment() as Peer | null;
      if (peer?.id) this.peers.set(ws, peer);
    }
    ctx.blockConcurrencyWhile(async () => {
      this.config = await ctx.storage.get<RoomConfig>('config') ?? null;
      const stored = await ctx.storage.get<PdfManifest[]>('files') ?? [];
      this.files = new Map(stored.map(file => [file.fileId, file]));
    });
  }

  private get host(): WebSocket | null {
    for (const [ws, peer] of this.peers) {
      if (peer.role === 'host' && ws.readyState === OPEN) return ws;
    }
    return null;
  }
  private student(id: string): { ws: WebSocket; peer: Peer } | null {
    for (const [ws, peer] of this.peers) if (peer.role === 'student' && peer.id === id) return { ws, peer };
    return null;
  }
  private students(): StudentInfo[] {
    return [...this.peers.values()]
      .filter(p => p.role === 'student')
      .map(p => ({ id: p.id, name: p.name, approved: p.approved }));
  }
  private sendHost(message: Record<string, unknown>): void { send(this.host, message); }
  private putPeer(ws: WebSocket, peer: Peer): void {
    this.peers.set(ws, peer);
    ws.serializeAttachment(peer);
  }
  private async persist(): Promise<void> {
    await this.ctx.storage.put('files', [...this.files.values()]);
  }
  private async terminate(): Promise<void> {
    for (const ws of this.peers.keys()) {
      send(ws, { type: 'room.closed' });
      ws.close(1000, 'Classroom ended');
    }
    this.peers.clear();
    this.files.clear();
    this.ranges.clear();
    this.config = null;
    await this.ctx.storage.deleteAll();
  }
  private expired(): boolean {
    return !this.config || Date.now() - this.config.created >= ROOM_TTL_MS;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      if (!this.expired()) return new Response('Room code in use', { status: 409 });
      if (this.config) await this.terminate();
      const incoming = await request.json() as Partial<RoomConfig>;
      if (!/^\d{6}$/.test(incoming.code ?? '') ||
          typeof incoming.hostToken !== 'string' || incoming.hostToken.length < 32 ||
          typeof incoming.joinToken !== 'string' || incoming.joinToken.length < 32) {
        return new Response('Invalid room', { status: 400 });
      }
      const created = Date.now();
      this.config = {
        code: incoming.code!, hostToken: incoming.hostToken, joinToken: incoming.joinToken, created,
      };
      await this.ctx.storage.put('config', this.config);
      await this.ctx.storage.setAlarm(created + ROOM_TTL_MS);
      return json({ roomId: this.config.code, code: this.config.code }, 201);
    }
    if (url.pathname !== '/ws' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    if (this.expired()) return new Response('Room expired', { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.putPeer(server, { id: crypto.randomUUID(), role: null, name: '', approved: false });
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private authenticate(ws: WebSocket, peer: Peer, msg: Record<string, unknown>): void {
    const cfg = this.config;
    if (!cfg || this.expired()) return void send(ws, { type: 'error', message: 'Room expired' });
    if (msg.role === 'host') {
      if (msg.roomId !== cfg.code || msg.token !== cfg.hostToken) {
        return void send(ws, { type: 'error', message: 'Invalid host credentials' });
      }
      for (const [other, active] of this.peers) {
        if (other !== ws && active.role === 'host') other.close(4000, 'Host reconnected');
      }
      this.putPeer(ws, { ...peer, role: 'host', name: 'Host', approved: true });
      send(ws, {
        type: 'room.state', id: cfg.code, code: cfg.code, joinToken: cfg.joinToken,
        students: this.students(), files: [...this.files.values()],
      });
      return;
    }
    if (msg.role === 'student') {
      if (msg.code !== cfg.code && msg.joinToken !== cfg.joinToken) {
        return void send(ws, { type: 'error', message: 'Room not found' });
      }
      if (!this.host) return void send(ws, { type: 'error', message: 'The host is offline' });
      if (this.students().length >= MAX_STUDENTS) return void send(ws, { type: 'error', message: 'Room is full' });
      const student: Peer = { ...peer, role: 'student', name: cleanText(msg.name, 32) || 'Student', approved: false };
      this.putPeer(ws, student);
      send(ws, { type: 'join.pending', roomCode: cfg.code });
      this.sendHost({ type: 'student.pending', student: { id: student.id, name: student.name, approved: false } });
      return;
    }
    send(ws, { type: 'error', message: 'Invalid role' });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const peer = this.peers.get(ws);
    if (!peer || this.expired()) return;
    if (typeof message !== 'string') {
      if (peer.role !== 'student' || !peer.approved ||
          message.byteLength > MAX_RANGE_BYTES + 2048) return;
      try {
        const { header, bytes } = decodeRangePacket(message);
        const range = this.ranges.get(header.requestId);
        if (!range || range.senderId !== peer.id || range.fileId !== header.fileId ||
            range.begin !== header.begin || range.end - range.begin !== bytes.byteLength) return;
        this.ranges.delete(header.requestId);
        this.host?.send(message);
      } catch { /* Ignore invalid binary frames and do not log user data. */ }
      return;
    }
    if (message.length > 8192) return void send(ws, { type: 'error', message: 'Message too large' });
    let msg: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(message);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      msg = value as Record<string, unknown>;
    } catch { return void send(ws, { type: 'error', message: 'Invalid message' }); }
    if (msg.type === 'hello') {
      if (peer.role !== null) return void send(ws, { type: 'error', message: 'Already authenticated' });
      this.authenticate(ws, peer, msg);
      return;
    }
    if (!peer.role) return void send(ws, { type: 'error', message: 'Authentication required' });

    if (peer.role === 'host') {
      if ((msg.type === 'student.accept' || msg.type === 'student.reject') && typeof msg.studentId === 'string') {
        const student = this.student(msg.studentId);
        if (student) {
          if (msg.type === 'student.accept') {
            student.peer.approved = true;
            this.putPeer(student.ws, student.peer);
            send(student.ws, { type: 'join.accepted', roomCode: this.config?.code });
            this.sendHost({ type: 'student.updated', student: { id: student.peer.id, name: student.peer.name, approved: true } });
          } else {
            send(student.ws, { type: 'join.rejected' });
            student.ws.close(1008, 'Rejected');
          }
        }
      } else if ((msg.type === 'file.approve' || msg.type === 'file.reject') && typeof msg.fileId === 'string') {
        const file = this.files.get(msg.fileId);
        const sender = file && this.student(file.ownerId);
        if (file?.status === 'pending' && sender) {
          file.status = msg.type === 'file.approve' ? 'approved' : 'rejected';
          await this.persist();
          send(sender.ws, { type: file.status === 'approved' ? 'file.approved' : 'file.rejected', fileId: file.fileId });
          this.sendHost({ type: 'file.updated', file });
        }
      } else if (msg.type === 'range.request') {
        const file = typeof msg.fileId === 'string' ? this.files.get(msg.fileId) : undefined;
        const begin = msg.begin, end = msg.end, requestId = msg.requestId;
        if (!validId(requestId) || !file || file.status !== 'approved' ||
            !Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
            Number(begin) < 0 || Number(end) <= Number(begin) || Number(end) > file.size ||
            Number(end) - Number(begin) > MAX_RANGE_BYTES || this.ranges.size >= 48) {
          return void send(ws, { type: 'range.error', requestId, message: 'Invalid or unavailable PDF range' });
        }
        const student = this.student(file.ownerId);
        if (!student || !student.peer.approved) {
          return void send(ws, { type: 'range.error', requestId, message: 'Sender is offline' });
        }
        for (const [id, pending] of this.ranges) {
          if (Date.now() - pending.created > RANGE_TIMEOUT_MS) this.ranges.delete(id);
        }
        if (this.ranges.has(requestId)) return;
        this.ranges.set(requestId, {
          fileId: file.fileId, senderId: student.peer.id,
          begin: Number(begin), end: Number(end), created: Date.now(),
        });
        send(student.ws, { type: 'range.request', requestId, fileId: file.fileId, begin, end });
      } else if (msg.type === 'range.cancel' && typeof msg.requestId === 'string') {
        this.ranges.delete(msg.requestId);
      } else if (msg.type === 'room.end') {
        await this.terminate();
      }
      return;
    }

    if (!peer.approved) return void send(ws, { type: 'error', message: 'Waiting for teacher approval' });
    if (msg.type === 'file.offer') {
      if (!validId(msg.fileId) || !Number.isSafeInteger(msg.size) ||
          Number(msg.size) < 1 || Number(msg.size) > MAX_PDF_BYTES ||
          this.files.has(msg.fileId) ||
          [...this.files.values()].filter(f => f.ownerId === peer.id).length >= 10) {
        return void send(ws, { type: 'error', message: 'Invalid PDF or file limit reached' });
      }
      const name = cleanText(msg.name, 130);
      if (!name.toLowerCase().endsWith('.pdf')) return void send(ws, { type: 'error', message: 'PDF files only' });
      const file: PdfManifest = {
        fileId: msg.fileId, name, size: Number(msg.size), status: 'pending',
        ownerId: peer.id, ownerName: peer.name,
      };
      this.files.set(file.fileId, file);
      await this.persist();
      this.sendHost({ type: 'file.announced', file });
      send(ws, { type: 'file.pending', fileId: file.fileId });
    } else if (msg.type === 'file.revoke' && typeof msg.fileId === 'string') {
      const file = this.files.get(msg.fileId);
      if (file?.ownerId === peer.id) {
        file.status = 'offline';
        await this.persist();
        this.sendHost({ type: 'file.updated', file });
      }
    } else if (msg.type === 'range.error' && typeof msg.requestId === 'string') {
      const pending = this.ranges.get(msg.requestId);
      if (pending?.senderId === peer.id) {
        this.ranges.delete(msg.requestId);
        this.sendHost({ type: 'range.error', requestId: msg.requestId, message: cleanText(msg.message, 120) || 'Sender could not read PDF' });
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const peer = this.peers.get(ws);
    if (!peer) return;
    this.peers.delete(ws);
    if (peer.role === 'host') {
      for (const [other, student] of this.peers) if (student.role === 'student') send(other, { type: 'host.offline' });
    } else if (peer.role === 'student') {
      for (const file of this.files.values()) {
        if (file.ownerId === peer.id) {
          file.status = 'offline';
          this.sendHost({ type: 'file.updated', file });
        }
      }
      await this.persist();
      for (const [id, req] of this.ranges) {
        if (req.senderId === peer.id) {
          this.ranges.delete(id);
          this.sendHost({ type: 'range.error', requestId: id, message: 'Sender disconnected' });
        }
      }
      this.sendHost({ type: 'student.left', id: peer.id });
    }
  }
  async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws); }
  async alarm(): Promise<void> { await this.terminate(); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, platform: 'cloudflare-free' });
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = String(100_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900_000));
        const config: RoomConfig = {
          code, hostToken: token(32), joinToken: code + '.' + token(24), created: Date.now(),
        };
        const room = env.ROOMS.getByName(code);
        const initialized = await room.fetch(new Request('https://internal/init', {
          method: 'POST', body: JSON.stringify(config),
        }));
        if (initialized.status === 201) {
          return json({
            roomId: code, code, joinToken: config.joinToken, hostToken: config.hostToken,
          }, 201);
        }
        if (initialized.status !== 409) return json({ error: 'Room creation unavailable' }, 503);
      }
      return json({ error: 'Unable to allocate a unique code' }, 503);
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden origin', { status: 403 });
      const code = url.searchParams.get('room');
      if (!code || !/^\d{6}$/.test(code)) return new Response('Room code required', { status: 400 });
      return env.ROOMS.getByName(code).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
