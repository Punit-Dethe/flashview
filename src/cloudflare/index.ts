import { DurableObject } from 'cloudflare:workers';
import { pruneExpiredRanges } from '../shared/rangeLiveness';
import { roomExpiresAt, shouldPersistRoomActivity } from '../shared/roomLifetime';
import { canForwardToHost } from '../shared/relayBackpressure';
import { resumeDisconnectedFile, revokeFile } from '../shared/fileLifecycle';
import { authorizeRoomControl, readRoomControlGeneration, RoomControlInputError, validControlToken } from '../shared/roomControl';
import {
  MAX_FILE_BYTES, MAX_STUDENT_FILES, MAX_RANGE_BYTES, ROOM_TTL_MS, RANGE_TIMEOUT_MS,
  decodeRangePacket, type PdfManifest, type StudentInfo,
} from '../shared/protocol';

interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}
type Role = 'host' | 'student' | null;
interface Peer { id: string; role: Role; name: string; approved: boolean }
interface RoomConfig { code: string; hostToken: string; joinToken: string; created: number; lastActivityAt?: number; autoApprove?: boolean;
  roomGeneration?: string; leaseToken?: string }
interface ResumeSession { id: string; name: string; approved: boolean; token: string }
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
  private sessions = new Map<string, ResumeSession>();
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
      const sessions = await ctx.storage.get<ResumeSession[]>('sessions') ?? [];
      this.sessions = new Map(sessions.map(session => [session.token, session]));
    });
  }

  private get host(): WebSocket | null {
    for (const [ws, peer] of this.peers) {
      if (peer.role === 'host' && ws.readyState === OPEN) return ws;
    }
    return null;
  }
  private student(id: string): { ws: WebSocket; peer: Peer } | null {
    for (const [ws, peer] of this.peers)
      if (peer.role === 'student' && peer.id === id && ws.readyState === OPEN)
        return { ws, peer };
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
  private async persistSessions(): Promise<void> {
    await this.ctx.storage.put('sessions', [...this.sessions.values()]);
  }
  private async terminate(): Promise<void> {
    // Commit termination before announcing it. A lost response can be retried
    // against this generation without resurrecting it or ending a reused code.
    await this.ctx.storage.deleteAll();
    this.config = null;
    for (const ws of this.peers.keys()) {
      send(ws, { type: 'room.closed' });
      ws.close(1000, 'Classroom ended');
    }
    this.peers.clear();
    this.files.clear();
    this.sessions.clear();
    this.ranges.clear();
  }
  private expired(): boolean {
    return !this.config || Date.now() >= roomExpiresAt(this.config.created, this.config.lastActivityAt);
  }

  /** Throttle durable writes while keeping live rooms from expiring mid-transfer. */
  private async touchHostActivity(): Promise<void> {
    const cfg = this.config;
    if (!cfg) return;
    const now = Date.now();
    if (!shouldPersistRoomActivity(cfg.lastActivityAt ?? cfg.created, now)) return;
    cfg.lastActivityAt = now;
    // Persist before rescheduling: an old alarm can still recover the new deadline.
    await this.ctx.storage.put('config', cfg);
    await this.ctx.storage.setAlarm(roomExpiresAt(cfg.created, cfg.lastActivityAt));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      const incoming = await request.json() as Partial<RoomConfig>;
      if (!/^\d{6}$/.test(incoming.code ?? '') ||
          typeof incoming.hostToken !== 'string' || incoming.hostToken.length < 32 ||
          typeof incoming.joinToken !== 'string' || incoming.joinToken.length < 32) {
        return new Response('Invalid room', { status: 400 });
      }
      return this.ctx.blockConcurrencyWhile(async () => {
        if (!this.expired()) return new Response('Room code in use', { status: 409 });
        if (this.config) await this.terminate();
        const created = Date.now();
        this.config = {
          code: incoming.code!, hostToken: incoming.hostToken!, joinToken: incoming.joinToken!, created,
          lastActivityAt: created, autoApprove: incoming.autoApprove === true,
          roomGeneration: incoming.roomGeneration ?? crypto.randomUUID(), leaseToken: incoming.leaseToken ?? token(32),
        };
        await this.ctx.storage.put('config', this.config);
        await this.ctx.storage.setAlarm(created + ROOM_TTL_MS);
        return json({ roomId: this.config.code, code: this.config.code }, 201);
      });
    }
    if (url.pathname === '/lease' || url.pathname === '/end') {
      if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
      const capability = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!validControlToken(capability)) return json({ error: 'Authorization required' }, 401);
      if (request.headers.get('Content-Type') !== 'application/json') return json({ error: 'JSON required' }, 415);
      const reader = request.body?.getReader();
      let generation: string;
      try { generation = await readRoomControlGeneration(reader); }
      catch (error) { return json({ error: 'Invalid control command' }, error instanceof RoomControlInputError ? error.status : 400); }
      finally { reader?.releaseLock(); }
      const action = url.pathname === '/lease' ? 'lease' : 'end';
      // The storage gate also serializes close/recreate against a renewal.
      return this.ctx.blockConcurrencyWhile(async () => {
        const cfg = this.config;
        const config = cfg?.roomGeneration && cfg.leaseToken ? { ...cfg,
          roomGeneration: cfg.roomGeneration, leaseToken: cfg.leaseToken } : null;
        const decision = authorizeRoomControl(config, generation, capability, action, Date.now());
        if (decision === 'denied') return json({ error: 'Invalid capability' }, 403);
        if (decision === 'absent') return json({ roomGeneration: generation, state: 'absent' });
        if (decision === 'expired' || action === 'end') {
          await this.terminate();
          return json({ roomGeneration: generation, state: 'closed' });
        }
        await this.touchHostActivity();
        return json({ roomGeneration: generation, state: 'active', expiresAt: roomExpiresAt(cfg!.created, cfg!.lastActivityAt) });
      });
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

  private async authenticate(ws: WebSocket, peer: Peer, msg: Record<string, unknown>): Promise<void> {
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
      if (!cfg.roomGeneration || !cfg.leaseToken) {
        cfg.roomGeneration ??= crypto.randomUUID();
        cfg.leaseToken ??= token(32);
        await this.ctx.storage.put('config', cfg);
      }
      await this.touchHostActivity();
      // Requests were owned by the old host socket. After a host resume they
      // cannot be delivered to the new socket safely; clear the volatile map
      // so it cannot block retries from the new receiver.
      this.ranges.clear();
      send(ws, {
        type: 'room.state', id: cfg.code, code: cfg.code, joinToken: cfg.joinToken,
        roomGeneration: cfg.roomGeneration, leaseToken: cfg.leaseToken,
        students: this.students(), files: [...this.files.values()],
        autoApprove: cfg.autoApprove === true,
      });
      for (const [studentSocket, student] of this.peers)
        if (student.role === 'student') send(studentSocket, { type: 'host.online' });
      return;
    }
    if (msg.role === 'student') {
      if (msg.code !== cfg.code && msg.joinToken !== cfg.joinToken) {
        return void send(ws, { type: 'error', message: 'Room not found' });
      }
      if (!this.host) return void send(ws, { type: 'error', message: 'The host is offline' });
      const previous = typeof msg.resumeToken === 'string' ? this.sessions.get(msg.resumeToken) : undefined;
      if (previous) {
        // The resume token only exists in this page's memory. Never send it to the teacher.
        const current = this.student(previous.id);
        if (current && current.ws !== ws) {
          this.peers.delete(current.ws);
          current.ws.close(4000, 'Session resumed on another socket');
        }
        this.putPeer(ws, {
          ...peer, id: previous.id, role: 'student', name: previous.name, approved: previous.approved,
        });
        let changed = false;
        for (const file of this.files.values()) {
          if (file.ownerId === previous.id && resumeDisconnectedFile(file, previous.approved)) {
            this.sendHost({ type: 'file.updated', file });
            changed = true;
          }
        }
        if (changed) await this.persist();
        const ownFiles = [...this.files.values()].filter(file => file.ownerId === previous.id);
        send(ws, {
          type: previous.approved ? 'join.resumed' : 'join.pending',
          roomCode: cfg.code, resumeToken: previous.token, files: ownFiles,
        });
        this.sendHost({
          type: 'student.updated',
          student: { id: previous.id, name: previous.name, approved: previous.approved },
        });
        return;
      }
      if (this.students().length >= MAX_STUDENTS) return void send(ws, { type: 'error', message: 'Room is full' });
      const approved = cfg.autoApprove === true;
      const newSession: ResumeSession = {
        id: peer.id, name: cleanText(msg.name, 32) || 'Student', approved, token: token(32),
      };
      this.sessions.set(newSession.token, newSession);
      await this.persistSessions();
      this.putPeer(ws, { ...peer, role: 'student', name: newSession.name, approved });
      send(ws, { type: approved ? 'join.accepted' : 'join.pending',
        roomCode: cfg.code, resumeToken: newSession.token });
      this.sendHost({
        type: approved ? 'student.updated' : 'student.pending',
        student: { id: peer.id, name: newSession.name, approved },
      });
      return;
    }
    send(ws, { type: 'error', message: 'Invalid role' });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const peer = this.peers.get(ws);
    if (!peer || this.expired()) return;
    if (peer.role === 'host' && this.host !== ws) return;
    if (typeof message !== 'string') {
      if (peer.role !== 'student' || !peer.approved ||
          message.byteLength > MAX_RANGE_BYTES + 2048) return;
      try {
        const { header, bytes } = decodeRangePacket(message);
        const range = this.ranges.get(header.requestId);
        if (!range || range.senderId !== peer.id || range.fileId !== header.fileId ||
            range.begin !== header.begin || range.end - range.begin !== bytes.byteLength) return;
        this.ranges.delete(header.requestId);
        const host = this.host;
        if (host && host.readyState === OPEN &&
            canForwardToHost(host.bufferedAmount, message.byteLength)) {
          try {
            host.send(message);
          } catch {
            send(host, { type: 'range.error', requestId: header.requestId,
              message: 'Receiver relay is temporarily overloaded' });
          }
        } else {
          // Never silently lose a response: the existing receiver backoff
          // retries this *same original file range*. The relay stores no bytes.
          send(host, { type: 'range.error', requestId: header.requestId,
            message: 'Receiver relay is temporarily overloaded' });
        }
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
      await this.authenticate(ws, peer, msg);
      return;
    }
    if (!peer.role) return void send(ws, { type: 'error', message: 'Authentication required' });
    if (peer.role === 'host') await this.touchHostActivity();
    if (msg.type === 'heartbeat.ping') return void send(ws, { type: 'heartbeat.pong' });
    // The database-backed manifest is authoritative, not best-effort live notifications.
    if (msg.type === 'room.sync' && peer.role === 'host') {
      return void send(ws, {
        type: 'room.state', id: this.config?.code, code: this.config?.code,
        joinToken: this.config?.joinToken, students: this.students(),
        roomGeneration: this.config?.roomGeneration, leaseToken: this.config?.leaseToken,
        files: [...this.files.values()],
      });
    }
    if (msg.type === 'file.sync' && peer.role === 'student' && peer.approved) {
      send(ws, {
        type: 'file.manifest',
        files: [...this.files.values()].filter(file => file.ownerId === peer.id),
      });
      return;
    }

    if (peer.role === 'host') {
      if (msg.type === 'cache.progress') {
        const file = typeof msg.fileId === 'string' ? this.files.get(msg.fileId) : undefined;
        const bytes = msg.bytes;
        // Hot path protection: ignore intermediate progress from older hosts.
        // Persist exactly once per completed PDF, not per cached chunk.
        // A zero snapshot can clear stale completed metadata after cache loss.
        if (file && Number.isSafeInteger(bytes) &&
            (bytes === file.size || (msg.snapshot === true && bytes === 0))) {
          const next = Number(bytes);
          if (file.cachedBytes !== next) {
            file.cachedBytes = next;
            await this.persist();
            const student = this.student(file.ownerId);
            if (student && student.peer.approved) send(student.ws, {
              type: 'cache.progress', fileId: file.fileId, bytes: next,
              size: file.size, complete: next === file.size,
            });
          }
          // This acknowledgment is deliberately returned even if the relay
          // already held the same cachedBytes. Lost receipts are safe to retry.
          if (next === file.size)
            send(ws, { type: 'cache.progress.receipt', fileId: file.fileId, bytes: next });
        }
        return;
      }
      if ((msg.type === 'student.accept' || msg.type === 'student.reject') && typeof msg.studentId === 'string') {
        const student = this.student(msg.studentId);
        if (student) {
          if (msg.type === 'student.accept') {
            student.peer.approved = true;
            this.putPeer(student.ws, student.peer);
            // Compatibility with pending documents created before automatic approval.
            let restored = false;
            for (const file of this.files.values()) {
              if (file.ownerId === student.peer.id && file.status === 'pending') {
                file.status = 'approved';
                this.sendHost({ type: 'file.updated', file });
                restored = true;
              }
            }
            if (restored) await this.persist();
            const session = [...this.sessions.values()].find(record => record.id === student.peer.id);
            if (session) {
              session.approved = true;
              await this.persistSessions();
            }
            send(student.ws, {
              type: 'join.accepted', roomCode: this.config?.code, resumeToken: session?.token,
            });
            this.sendHost({ type: 'student.updated', student: { id: student.peer.id, name: student.peer.name, approved: true } });
          } else {
            const session = [...this.sessions.values()].find(record => record.id === student.peer.id);
            if (session) {
              this.sessions.delete(session.token);
              await this.persistSessions();
            }
            send(student.ws, { type: 'join.rejected' });
            student.ws.close(1008, 'Rejected');
          }
        }
      } else if (msg.type === 'range.request') {
        // Critical ordering: expired requests must be removed *before* the
        // 48-request capacity guard. Previously a full table of expired
        // requests could reject every retry forever.
        const expired = pruneExpiredRanges(this.ranges, Date.now(), RANGE_TIMEOUT_MS);
        for (const id of expired) this.sendHost({
          type: 'range.error', requestId: id, message: 'Request timed out',
        });
        const file = typeof msg.fileId === 'string' ? this.files.get(msg.fileId) : undefined;
        const begin = msg.begin, end = msg.end, requestId = msg.requestId;
        if (!validId(requestId) || !file || file.status !== 'approved' ||
            !Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
            Number(begin) < 0 || Number(end) <= Number(begin) || Number(end) > file.size ||
            Number(end) - Number(begin) > MAX_RANGE_BYTES || this.ranges.size >= 48) {
          return void send(ws, { type: 'range.error', requestId, message: 'Invalid or unavailable file range' });
        }
        const student = this.student(file.ownerId);
        if (!student || !student.peer.approved) {
          return void send(ws, { type: 'range.error', requestId, message: 'Sender is offline' });
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
        await this.ctx.blockConcurrencyWhile(async () => { await this.terminate(); });
      }
      return;
    }

    if (!peer.approved) return void send(ws, { type: 'error', message: 'Waiting for teacher approval' });
    if (msg.type === 'preview.chunk') {
      const file = typeof msg.fileId === 'string' ? this.files.get(msg.fileId) : undefined;
      if (!file || file.ownerId !== peer.id || file.status !== 'approved' ||
          !Number.isSafeInteger(msg.part) || !Number.isSafeInteger(msg.total) ||
          Number(msg.part) < 0 || Number(msg.total) < 1 || Number(msg.total) > 80 ||
          Number(msg.part) >= Number(msg.total) ||
          typeof msg.data !== 'string' || msg.data.length < 1 || (msg.data.length > 7000 || (msg.data.length > 5000 && Number(msg.total) > 16)) ||
          !/^[a-zA-Z0-9+/=]+$/.test(msg.data)) return;
      this.sendHost({
        type: 'preview.chunk', fileId: file.fileId,
        part: msg.part, total: msg.total, data: msg.data,
      });
      return;
    }
    if (msg.type === 'file.offer') {
      if (!validId(msg.fileId) || !Number.isSafeInteger(msg.size) ||
          Number(msg.size) < 1 || Number(msg.size) > MAX_FILE_BYTES ||
          [...this.files.values()].filter(f => f.ownerId === peer.id).length >= MAX_STUDENT_FILES &&
            !this.files.has(msg.fileId)) {
        return void send(ws, { type: 'error', message: 'Invalid file size or room file limit reached' });
      }
      const name = cleanText(msg.name, 130);
      if (!name || name === '.' || name === '..') return void send(ws, { type: 'error', message: 'File name required' });
      const existing = this.files.get(msg.fileId);
      if (existing) {
        if (existing.status === 'pending' && peer.approved) {
          existing.status = 'approved';
          await this.persist();
          this.sendHost({ type: 'file.updated', file: existing });
        }
        // Replaying an offer is safe: never downgrade teacher approval.
        if (existing.ownerId !== peer.id || existing.size !== Number(msg.size) || existing.name !== name) {
          return void send(ws, { type: 'error', message: 'Conflicting document ID' });
        }
        return void send(ws, { type: 'file.state', file: existing });
      }
      const file: PdfManifest = {
        fileId: msg.fileId, name, size: Number(msg.size), status: 'approved',
        ownerId: peer.id, ownerName: peer.name,
      };
      this.files.set(file.fileId, file);
      await this.persist();
      this.sendHost({ type: 'file.announced', file });
      send(ws, { type: 'file.approved', fileId: file.fileId });
      send(ws, { type: 'file.state', file });
    } else if (msg.type === 'file.revoke' && typeof msg.fileId === 'string') {
      const file = this.files.get(msg.fileId);
      if (file?.ownerId === peer.id) {
        revokeFile(file);
        for (const [requestId, range] of this.ranges) {
          if (range.fileId !== file.fileId) continue;
          this.ranges.delete(requestId);
          this.sendHost({ type: 'range.error', requestId, message: 'File sharing stopped' });
        }
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
    if (peer.role === 'student' && this.student(peer.id)) {
      // Old socket's close event arrived after a successful session resume.
      return;
    }
    if (peer.role === 'host') {
      // Host handover closes the old socket after its replacement authenticates.
      // Do not tell phones the room is offline when that OLD socket closes.
      if (!this.host) {
        for (const [other, student] of this.peers)
          if (student.role === 'student') send(other, { type: 'host.offline' });
      }
    } else if (peer.role === 'student') {
      for (const file of this.files.values()) {
        if (file.ownerId === peer.id && file.status === 'approved') {
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
  async alarm(): Promise<void> {
    if (!this.config) return;
    const deadline = roomExpiresAt(this.config.created, this.config.lastActivityAt);
    // An alarm scheduled before the latest authenticated host activity must
    // never destroy an otherwise live classroom after Durable Object hibernation.
    if (Date.now() < deadline) {
      await this.ctx.storage.setAlarm(deadline);
      return;
    }
    await this.terminate();
  }
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
          roomGeneration: crypto.randomUUID(), leaseToken: token(32),
          autoApprove: url.searchParams.get('autoApprove') === '1',
        };
        const room = env.ROOMS.getByName(code);
        const initialized = await room.fetch(new Request('https://internal/init', {
          method: 'POST', body: JSON.stringify(config),
        }));
        if (initialized.status === 201) {
          return json({
            roomId: code, code, joinToken: config.joinToken, hostToken: config.hostToken,
            roomGeneration: config.roomGeneration, leaseToken: config.leaseToken,
            autoApprove: config.autoApprove,
          }, 201);
        }
        if (initialized.status !== 409) return json({ error: 'Room creation unavailable' }, 503);
      }
      return json({ error: 'Unable to allocate a unique code' }, 503);
    }
    const control = /^\/api\/rooms\/(\d{6})\/(lease|end)$/.exec(url.pathname);
    if (control) {
      if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
      if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)
        return json({ error: 'Forbidden origin' }, 403);
      if (!validControlToken(request.headers.get('Authorization')?.replace(/^Bearer /, '')))
        return json({ error: 'Authorization required' }, 401);
      if (request.headers.get('Content-Type') !== 'application/json') return json({ error: 'JSON required' }, 415);
      return env.ROOMS.getByName(control[1]).fetch(new Request('https://internal/' + control[2], request));
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
