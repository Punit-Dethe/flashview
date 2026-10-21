import { DurableObject } from 'cloudflare:workers';
import { checkCreationPermit } from './creationPermit';
import { roomCacheIdentity } from '../shared/roomCacheIdentity';
import { RoomEngine, type ResumeSession } from '../shared/roomEngine';
import { versionedMetadata } from '../shared/roomVersion';
import type { FileTransition } from '../shared/roomFileEngine';
import { AUTH_TIMEOUT_MS, MAX_PENDING_ROOM, MAX_ROOM_SOCKETS, CREATION_LIMIT, CREATION_WINDOW_MS,
  consumeWindow, nextRoomAlarm, retryAfterSeconds, type RateWindow } from '../shared/connectionGuards';
import { pruneExpiredRanges } from '../shared/rangeLiveness';
import { roomExpiresAt, shouldPersistRoomActivity } from '../shared/roomLifetime';
import { canForwardToHost } from '../shared/relayBackpressure';
import { authorizeRoomControl, readRoomControlGeneration, RoomControlInputError, validControlToken } from '../shared/roomControl';
import {
  MAX_RANGE_BYTES, ROOM_TTL_MS, RANGE_TIMEOUT_MS,
  decodeRangePacket, type PdfManifest, type StudentInfo,
} from '../shared/protocol';

interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}
type Role = 'host' | 'student' | null;
interface Peer { id: string; role: Role; name: string; approved: boolean; authDeadline?: number }
interface RoomConfig { code: string; hostToken: string; joinToken: string; created: number; lastActivityAt?: number; autoApprove?: boolean;
  roomGeneration?: string; leaseToken?: string; cacheVersion?: 2 }
interface RangeRequest { fileId: string; senderId: string; begin: number; end: number; created: number }
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
  private engine = new RoomEngine();
  private get fileState() { return this.engine.fileState; }
  private get files(): ReadonlyMap<string, PdfManifest> { return this.fileState.files; }
  private creationWindow: RateWindow | null = null;
  // Deliberately volatile: a hibernation race is retried by the client's range timeout.
  private ranges = new Map<string, RangeRequest>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    let upgradedPending = false;
    for (const ws of ctx.getWebSockets()) {
      const peer = ws.deserializeAttachment() as Peer | null;
      if (peer?.id) {
        if (peer.role === null && peer.authDeadline === undefined) {
          upgradedPending = true;
          peer.authDeadline = Date.now() + AUTH_TIMEOUT_MS;
          ws.serializeAttachment(peer);
        }
        this.peers.set(ws, peer);
      }
    }
    ctx.blockConcurrencyWhile(async () => {
      this.config = await ctx.storage.get<RoomConfig>('config') ?? null;
      const metadata = await ctx.storage.get<unknown>(['files', 'sessions', 'joinWindow', 'roomRevision']);
      this.engine = new RoomEngine({ files: metadata.get('files') as PdfManifest[] | undefined,
        sessions: metadata.get('sessions') as ResumeSession[] | undefined,
        joinWindow: metadata.get('joinWindow') as RateWindow | undefined,
        roomRevision: metadata.get('roomRevision') as number | undefined });
      for (const [ws, peer] of this.peers) {
        if (peer.role === 'host') this.engine.restoreHost(ws);
        if (peer.role === 'student') {
          const participant = this.engine.restoreParticipant(ws, peer.id);
          if (participant) this.putPeer(ws, { ...peer, name: participant.name, approved: participant.approved });
          else { this.peers.delete(ws); ws.serializeAttachment(null); try { ws.close(4000, 'Session not restored'); } catch {} }
        }
      }
      this.creationWindow = await ctx.storage.get<RateWindow>('creationWindow') ?? null;
      // Never postpone an already-due alarm when recovering from hibernation.
      if (this.config && upgradedPending) {
        const current = await ctx.storage.getAlarm();
        const next = this.nextAlarm();
        if (current === null || next < current) await ctx.storage.setAlarm(next);
      }
    });
  }

  private get host(): WebSocket | null {
    for (const [ws, peer] of this.peers) {
      if (peer.role === 'host' && ws.readyState === OPEN && this.engine.isHost(ws)) return ws;
    }
    return null;
  }
  private student(id: string): { ws: WebSocket; peer: Peer } | null {
    for (const [ws, peer] of this.peers)
      if (peer.role === 'student' && peer.id === id && ws.readyState === OPEN && this.engine.participant(id)?.connection === ws)
        return { ws, peer };
    return null;
  }
  private students(): StudentInfo[] {
    return this.engine.students();
  }
  private sendPeer(ws: WebSocket | null, message: Record<string, unknown>): void {
    send(ws, { ...message, ...(this.config && versionedMetadata(message.type)
      ? { roomGeneration: this.config.roomGeneration, roomRevision: this.engine.revision } : {}) });
  }
  private sendHost(message: Record<string, unknown>): void { this.sendPeer(this.host, message); }

  private putPeer(ws: WebSocket, peer: Peer): void {
    this.peers.set(ws, peer);
    ws.serializeAttachment(peer);
  }
  private async commitFiles(changes: FileTransition[], actor?: WebSocket): Promise<void> {
    const engine = this.engine, config = this.config;
    if (!config) return;
    do {
      await engine.persist(snapshot => this.engine !== engine || this.config !== config ? Promise.resolve() :
        this.ctx.storage.put({ files: snapshot.files, sessions: snapshot.sessions,
          joinWindow: snapshot.joinWindow, roomRevision: snapshot.roomRevision }));
    } while (this.engine === engine && this.config === config && engine.needsPersistence);
    if (this.engine !== engine || this.config !== config || !config) return;
    for (const change of changes) for (const effect of engine.fileState.effects(change)) {
      if (effect.to === 'host') this.sendHost(effect.message);
      else if (effect.to === 'owner') {
        const owner = this.student(effect.ownerId!);
        if (owner?.peer.approved) this.sendPeer(owner.ws, effect.message);
      } else if (actor) {
        const peer = this.peers.get(actor);
        if (peer?.role === 'host' ? this.host === actor :
            peer?.role === 'student' && this.student(peer.id)?.ws === actor) this.sendPeer(actor, effect.message);
      }
    }
  }
  private nextAlarm(): number {
    const expires = this.config ? roomExpiresAt(this.config.created, this.config.lastActivityAt) : Date.now();
    return nextRoomAlarm(expires, [...this.peers.values()]
      .filter(peer => peer.role === null).map(peer => peer.authDeadline ?? Date.now()));
  }
  private async scheduleRoomAlarm(onlyEarlier = false): Promise<void> {
    if (!this.config) return;
    const current = await this.ctx.storage.getAlarm();
    const next = this.nextAlarm();
    if (current === next || (onlyEarlier && current !== null && current < next)) return;
    await this.ctx.storage.setAlarm(next);
  }
  private rejectAuthentication(ws: WebSocket, message: string): void {
    this.peers.delete(ws); ws.serializeAttachment(null);
    try { this.sendPeer(ws, { type: 'error', message }); } catch { /* Already closing. */ }
    try { ws.close(1008, 'Authentication failed'); } catch { /* Already closed. */ }
  }
  private expirePending(now: number): void {
    for (const [ws, peer] of this.peers)
      if (peer.role === null && now >= (peer.authDeadline ?? 0))
        this.rejectAuthentication(ws, 'Authentication timed out');
  }
  private async terminate(): Promise<void> {
    // Commit termination before announcing it. A lost response can be retried
    // against this generation without resurrecting it or ending a reused code.
    const roomGeneration = this.config?.roomGeneration;
    await this.ctx.storage.deleteAll();
    this.config = null;
    const sockets = [...this.peers.keys()];
    this.peers.clear();
    this.engine.clear();
    this.ranges.clear();
    for (const ws of sockets) {
      ws.serializeAttachment(null);
      // Committed closure must not become a failed command because one peer's
      // transport was already closing or failed to accept its final notice.
      try { this.sendPeer(ws, { type: 'room.closed', roomGeneration, roomRevision: this.engine.revision }); } catch { /* Best-effort notice. */ }
      try { ws.close(1000, 'Classroom ended'); } catch { /* Already closing. */ }
    }
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
    await this.scheduleRoomAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Only the outer Worker addresses these prefixed, non-room objects. No
    // public route forwards this endpoint or permits a non-numeric room name.
    if (url.pathname === '/creation-permit' && request.method === 'POST') {
      return this.ctx.blockConcurrencyWhile(async () => {
        if (this.config) return new Response('Invalid guard object', { status: 409 });
        const result = consumeWindow(this.creationWindow, CREATION_LIMIT, CREATION_WINDOW_MS, Date.now());
        if (!result.allowed) return new Response(JSON.stringify({
          error: 'Room creation is temporarily limited for this connection. Please try again later.',
        }), { status: 429, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
          'Retry-After': retryAfterSeconds(result.retryAfterMs) } });
        this.creationWindow = result.window;
        await this.ctx.storage.put('creationWindow', this.creationWindow);
        await this.ctx.storage.setAlarm(this.creationWindow.reset);
        return json({ allowed: true });
      });
    }
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
        this.engine = new RoomEngine();
        this.config = {
          code: incoming.code!, hostToken: incoming.hostToken!, joinToken: incoming.joinToken!, created,
          lastActivityAt: created, autoApprove: incoming.autoApprove === true,
          roomGeneration: incoming.roomGeneration ?? crypto.randomUUID(), leaseToken: incoming.leaseToken ?? token(32),
          cacheVersion: incoming.cacheVersion === 2 ? 2 : undefined,
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
    this.expirePending(Date.now());
    if ([...this.peers.values()].filter(peer => peer.role === null).length >= MAX_PENDING_ROOM ||
        this.ctx.getWebSockets().length >= MAX_ROOM_SOCKETS)
      return new Response('Room connection queue is busy', { status: 503, headers: { 'Retry-After': '1' } });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.putPeer(server, { id: crypto.randomUUID(), role: null, name: '', approved: false,
      authDeadline: Date.now() + AUTH_TIMEOUT_MS });
    await this.scheduleRoomAlarm(true);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  private async authenticate(ws: WebSocket, peer: Peer, msg: Record<string, unknown>): Promise<void> {
    const cfg = this.config;
    if (!cfg || this.expired()) return void this.rejectAuthentication(ws, 'Room expired');
    if (msg.role === 'host') {
      if (msg.roomId !== cfg.code || msg.token !== cfg.hostToken) {
        return void this.rejectAuthentication(ws, 'Invalid host credentials');
      }
      for (const [other, active] of this.peers) {
        if (other !== ws && active.role === 'host') {
          this.peers.delete(other);
          other.serializeAttachment(null);
          other.close(4000, 'Host reconnected');
        }
      }
      this.engine.connectHost(ws);
      this.putPeer(ws, { ...peer, role: 'host', name: 'Host', approved: true });
      if (!cfg.roomGeneration || !cfg.leaseToken) {
        cfg.roomGeneration ??= crypto.randomUUID();
        cfg.leaseToken ??= token(32);
        await this.ctx.storage.put('config', cfg);
      }
      await this.touchHostActivity();
      if (!this.peers.has(ws)) return;
      // Requests were owned by the old host socket. After a host resume they
      // cannot be delivered to the new socket safely; clear the volatile map
      // so it cannot block retries from the new receiver.
      this.ranges.clear();
      await this.commitFiles([]);
      if (this.config !== cfg || this.host !== ws) return;
      this.sendPeer(ws, {
        type: 'room.state', id: cfg.code, code: cfg.code, joinToken: cfg.joinToken,
        roomGeneration: cfg.roomGeneration, leaseToken: cfg.leaseToken,
        cacheId: roomCacheIdentity(cfg),
        students: this.students(), files: [...this.files.values()],
        autoApprove: cfg.autoApprove === true,
      });
      for (const [studentSocket, student] of this.peers)
        if (student.role === 'student') this.sendPeer(studentSocket, { type: 'host.online' });
      return;
    }
    if (msg.role === 'student') {
      if (msg.code !== cfg.code && msg.joinToken !== cfg.joinToken) {
        return void this.rejectAuthentication(ws, 'Room not found');
      }
      const joined = this.engine.join({ connection: ws, id: peer.id, name: msg.name, resumeToken: msg.resumeToken,
        newToken: token(32), autoApprove: cfg.autoApprove === true, hostOnline: !!this.host, now: Date.now() });
      if (joined.kind === 'rejected') {
        if (joined.code === 'HOST_OFFLINE') { this.rejectAuthentication(ws, joined.message); return; }
        this.peers.delete(ws); ws.serializeAttachment(null);
        this.sendPeer(ws, { type: joined.retryable ? 'error' : 'join.rejected', code: joined.code,
          message: joined.message, retryable: joined.retryable, retryAfterMs: joined.retryAfterMs });
        ws.close(1008, 'Room admission limit'); return;
      }
      if (joined.displaced) {
        const old = joined.displaced as WebSocket;
        this.peers.delete(old); old.serializeAttachment(null);
        if (old.readyState === OPEN) old.close(4000, 'Session resumed on another socket');
      }
      const participant = joined.participant;
      this.putPeer(ws, { ...peer, id: participant.id, role: 'student', name: participant.name, approved: participant.approved });
      await this.commitFiles(joined.changes);
      if (this.config !== cfg || !this.engine.isCurrent(participant)) return;
      this.sendPeer(ws, { type: participant.approved ? (joined.resumed ? 'join.resumed' : 'join.accepted') : 'join.pending',
        roomCode: cfg.code, resumeToken: participant.token,
        ...(joined.resumed ? { files: [...this.files.values()].filter(file => file.ownerId === participant.id) } : {}) });
      if (joined.resumed && !this.host) this.sendPeer(ws, { type: 'host.offline' });
      if (joined.resumed) for (const [requestId, range] of this.ranges) {
        if (range.senderId === participant.id && this.files.get(range.fileId)?.status === 'approved')
          this.sendPeer(ws, { type: 'range.request', requestId, fileId: range.fileId, begin: range.begin, end: range.end });
      }
      this.sendHost({ type: joined.resumed || participant.approved ? 'student.updated' : 'student.pending',
        student: { id: participant.id, name: participant.name, approved: participant.approved } });
      return;
    }
    this.rejectAuthentication(ws, 'Invalid role');
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const peer = this.peers.get(ws);
    if (!peer || this.expired()) return;
    if (peer.role === null && Date.now() >= (peer.authDeadline ?? 0)) {
      this.rejectAuthentication(ws, 'Authentication timed out'); return;
    }
    if (peer.role === 'host' && this.host !== ws) return;
    if (typeof message !== 'string') {
      if (peer.role === null) { this.rejectAuthentication(ws, 'Authentication required'); return; }
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
            this.sendPeer(host, { type: 'range.error', requestId: header.requestId,
              message: 'Receiver relay is temporarily overloaded' });
          }
        } else {
          // Never silently lose a response: the existing receiver backoff
          // retries this *same original file range*. The relay stores no bytes.
          this.sendPeer(host, { type: 'range.error', requestId: header.requestId,
            message: 'Receiver relay is temporarily overloaded' });
        }
      } catch { /* Ignore invalid binary frames and do not log user data. */ }
      return;
    }
    if (message.length > 8192) {
      if (peer.role === null) this.rejectAuthentication(ws, 'Message too large');
      else this.sendPeer(ws, { type: 'error', message: 'Message too large' });
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(message);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid message');
      msg = value as Record<string, unknown>;
    } catch {
      if (peer.role === null) this.rejectAuthentication(ws, 'Invalid message');
      else this.sendPeer(ws, { type: 'error', message: 'Invalid message' });
      return;
    }
    if (msg.type === 'hello') {
      if (peer.role !== null) return void this.sendPeer(ws, { type: 'error', message: 'Already authenticated' });
      await this.authenticate(ws, peer, msg);
      return;
    }
    if (!peer.role) return void this.rejectAuthentication(ws, 'Authentication required');
    if (peer.role === 'host') {
      await this.touchHostActivity();
      if (this.peers.get(ws) !== peer) return;
    }
    if (msg.type === 'heartbeat.ping') return void this.sendPeer(ws, { type: 'heartbeat.pong' });
    if ((msg.type === 'room.sync' && peer.role === 'host') ||
        (msg.type === 'file.sync' && peer.role === 'student')) {
      const config = this.config;
      if (this.engine.needsPersistence) await this.commitFiles([]);
      if (this.config !== config || this.peers.get(ws) !== peer) return;
    }
    // The database-backed manifest is authoritative, not best-effort live notifications.
    if (msg.type === 'room.sync' && peer.role === 'host') {
      return void this.sendPeer(ws, {
        type: 'room.state', id: this.config?.code, code: this.config?.code,
        joinToken: this.config?.joinToken, students: this.students(),
        roomGeneration: this.config?.roomGeneration, leaseToken: this.config?.leaseToken,
        cacheId: this.config ? roomCacheIdentity(this.config) : undefined,
        files: [...this.files.values()],
      });
    }
    if (msg.type === 'file.sync' && peer.role === 'student') {
      this.sendPeer(ws, {
        type: 'file.manifest', approved: peer.approved, roomCode: this.config?.code, hostOnline: !!this.host,
        files: [...this.files.values()].filter(file => file.ownerId === peer.id),
      });
      return;
    }

    if (peer.role === 'host') {
      if (msg.type === 'file.remove') {
        const change = this.fileState.remove(msg.fileId);
        if (change) {
          for (const [id, pending] of this.ranges) if (pending.fileId === change.file.fileId) {
            this.ranges.delete(id);
            this.sendHost({ type: 'range.error', requestId: id, message: 'File deleted' });
          }
          await this.commitFiles([change], ws);
        }
        return;
      }
      if (msg.type === 'cache.progress') {
        const change = this.fileState.cacheProgress(msg.fileId, msg.bytes, msg.snapshot);
        if (change) await this.commitFiles([change], ws);
        return;
      }
      if ((msg.type === 'student.accept' || msg.type === 'student.reject') && typeof msg.studentId === 'string') {
        const config = this.config, student = this.student(msg.studentId);
        if (msg.type === 'student.accept') {
          const result = this.engine.approve(msg.studentId);
          if (!result || !student) return;
          this.putPeer(student.ws, { ...student.peer, approved: true });
          await this.commitFiles(result.changes);
          if (this.config !== config || !this.engine.isCurrent(result.participant)) return;
          this.sendPeer(student.ws, { type: 'join.accepted', roomCode: config?.code, resumeToken: result.participant.token });
          this.sendHost({ type: 'student.updated', student: { id: result.participant.id, name: result.participant.name, approved: true } });
        } else {
          const result = this.engine.reject(msg.studentId);
          if (!result) return;
          if (student) { this.peers.delete(student.ws); student.ws.serializeAttachment(null); }
          for (const [id, range] of this.ranges) if (range.senderId === msg.studentId) {
            this.ranges.delete(id); this.sendHost({ type: 'range.error', requestId: id, message: 'Sender disconnected' });
          }
          await this.commitFiles(result.changes);
          if (this.config !== config) return;
          if (!this.engine.participant(msg.studentId)) this.sendHost({ type: 'student.left', id: msg.studentId });
          if (student) { this.sendPeer(student.ws, { type: 'join.rejected' }); student.ws.close(1008, 'Rejected'); }
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
          return void this.sendPeer(ws, { type: 'range.error', requestId, message: 'Invalid or unavailable file range' });
        }
        const student = this.student(file.ownerId);
        if (!student || !student.peer.approved) {
          return void this.sendPeer(ws, { type: 'range.error', requestId, message: 'Sender is offline' });
        }
        if (this.ranges.has(requestId)) return;
        this.ranges.set(requestId, {
          fileId: file.fileId, senderId: student.peer.id,
          begin: Number(begin), end: Number(end), created: Date.now(),
        });
        this.sendPeer(student.ws, { type: 'range.request', requestId, fileId: file.fileId, begin, end });
      } else if (msg.type === 'range.cancel' && typeof msg.requestId === 'string') {
        this.ranges.delete(msg.requestId);
      } else if (msg.type === 'room.end') {
        await this.ctx.blockConcurrencyWhile(async () => { await this.terminate(); });
      }
      return;
    }

    if (!peer.approved) return void this.sendPeer(ws, { type: 'error', message: 'Waiting for teacher approval' });
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
      const result = this.fileState.offer(peer, msg);
      if (result.kind === 'rejected') return void this.sendPeer(ws, {
        type: 'file.rejected', fileId: msg.fileId, code: result.code, message: result.message,
      });
      await this.commitFiles([result], ws);
    } else if (msg.type === 'file.revoke' && typeof msg.fileId === 'string') {
      const change = this.fileState.revoke(peer.id, msg.fileId);
      if (change) {
        for (const [requestId, range] of this.ranges) {
          if (range.fileId !== change.file.fileId) continue;
          this.ranges.delete(requestId);
          this.sendHost({ type: 'range.error', requestId, message: 'File sharing stopped' });
        }
        await this.commitFiles([change], ws);
      }
    } else if (msg.type === 'range.error' && typeof msg.requestId === 'string') {
      const pending = this.ranges.get(msg.requestId);
      if (pending?.senderId === peer.id) {
        this.ranges.delete(msg.requestId);
        this.sendHost({ type: 'range.error', requestId: msg.requestId, message: cleanText(msg.message, 120) || 'Sender could not read PDF' });
      }
    }
  }

  private async removePeer(ws: WebSocket): Promise<void> {
    const peer = this.peers.get(ws);
    if (!peer) return;
    this.peers.delete(ws);
    ws.serializeAttachment(null);
    if (peer.role === 'student' && this.student(peer.id)) {
      // Old socket's close event arrived after a successful session resume.
      return;
    }
    const config = this.config;
    if (peer.role === 'host') {
      if (!this.engine.disconnectHost(ws)) return;
      await this.commitFiles([]);
      if (this.config === config && !this.host) for (const [other, student] of this.peers)
        if (student.role === 'student') this.sendPeer(other, { type: 'host.offline' });
    } else if (peer.role === 'student') {
      const departure = this.engine.disconnect(peer.id, ws);
      if (!departure) return;
      for (const [id, req] of this.ranges) if (req.senderId === peer.id) {
        this.ranges.delete(id); this.sendHost({ type: 'range.error', requestId: id, message: 'Sender disconnected' });
      }
      await this.commitFiles(departure.changes);
      if (this.config !== config || this.engine.participant(peer.id)) return;
      this.sendHost({ type: 'student.left', id: peer.id });
    }
  }
  async webSocketClose(ws: WebSocket): Promise<void> {
    // Modern runtimes reciprocate automatically; this is a harmless no-op on
    // CLOSED sockets and also finishes closure on runtimes without that behavior.
    try { ws.close(1000, 'Connection closed'); } catch { /* Already disconnected. */ }
    await this.removePeer(ws);
  }
  async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws); }
  async alarm(): Promise<void> {
    if (this.creationWindow && !this.config) {
      if (Date.now() >= this.creationWindow.reset) {
        await this.ctx.storage.deleteAll(); this.creationWindow = null;
      } else await this.ctx.storage.setAlarm(this.creationWindow.reset);
      return;
    }
    if (!this.config) return;
    this.expirePending(Date.now());
    const deadline = roomExpiresAt(this.config.created, this.config.lastActivityAt);
    // An alarm scheduled before the latest authenticated host activity must
    // never destroy an otherwise live classroom after Durable Object hibernation.
    if (Date.now() < deadline) {
      await this.scheduleRoomAlarm();
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
      if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)
        return json({ error: 'Forbidden origin' }, 403);
      // Cloudflare supplies this address at the edge; never accept a client
      // forwarded-for header. Hashing avoids storing the raw address in a name.
      const source = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const guard = await checkCreationPermit(source, env.ROOMS);
      if (guard.denial) return guard.denial;
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = String(100_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900_000));
        const config: RoomConfig = {
          code, hostToken: token(32), joinToken: code + '.' + token(24), created: Date.now(),
          roomGeneration: crypto.randomUUID(), leaseToken: token(32),
          cacheVersion: url.searchParams.get('cache') === '2' ? 2 : undefined,
          autoApprove: url.searchParams.get('autoApprove') === '1',
        };
        const room = env.ROOMS.getByName(code);
        const initialized = await room.fetch(new Request('https://internal/init', {
          method: 'POST', body: JSON.stringify(config),
        }));
        if (initialized.status === 201) {
          const response = json({
            roomId: code, code, joinToken: config.joinToken, hostToken: config.hostToken,
            roomGeneration: config.roomGeneration, leaseToken: config.leaseToken,
            cacheId: roomCacheIdentity(config),
            autoApprove: config.autoApprove,
          }, 201);
          response.headers.set('X-WarpView-Creation-Guard', guard.mode);
          return response;
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
