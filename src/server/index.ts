import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { roomExpiresAt } from '../shared/roomLifetime.js';
import { roomCacheIdentity } from '../shared/roomCacheIdentity.js';
import { RoomEngine } from '../shared/roomEngine.js';
import { versionedMetadata } from '../shared/roomVersion.js';
import type { RoomFileEngine, FileTransition } from '../shared/roomFileEngine.js';
import { AUTH_TIMEOUT_MS, MAX_PENDING_NODE, MAX_NODE_SOCKETS, CreationBuckets, retryAfterSeconds } from '../shared/connectionGuards.js';
import { authorizeRoomControl, readRoomControlGeneration, RoomControlInputError, validControlToken } from '../shared/roomControl.js';
import {
  decodeRangePacket, MAX_RANGE_BYTES, RANGE_TIMEOUT_MS, ROOM_TTL_MS,
  type PdfManifest, type StudentInfo,
} from '../shared/protocol.js';

type Role = 'host' | 'student';
type Peer = { ws: WebSocket; id: string; role: Role; room: Room; approved: boolean; name: string };
type Outstanding = { fileId: string; senderId: string; begin: number; end: number; created: number };
type Room = {
  id: string; code: string; joinToken: string; hostToken: string; roomGeneration: string; leaseToken: string;
  autoApprove: boolean; cacheVersion?: 2 | 3; engine: RoomEngine;
  created: number; lastActivityAt: number; host: Peer | null; students: Map<string, Peer>;
  files: ReadonlyMap<string, PdfManifest>; fileState: RoomFileEngine; outstanding: Map<string, Outstanding>;
};
const rooms = new Map<string, Room>();
const connections = new WeakMap<WebSocket, Peer>();
const roomCreationByIp = new CreationBuckets();
const pendingAuth = new Map<WebSocket, { deadline: number; timer: ReturnType<typeof setTimeout> }>();
const MAX_ROOMS = 100;
const PORT = Number(process.env.PORT ?? 3000);
const publicDir = resolve(process.cwd(), 'dist');

function randomToken(bytes = 24): string { return randomBytes(bytes).toString('base64url'); }
function releasePending(ws: WebSocket): void {
  const pending = pendingAuth.get(ws);
  if (pending) clearTimeout(pending.timer);
  pendingAuth.delete(ws);
}
function rejectAuthentication(ws: WebSocket, message: string): void {
  releasePending(ws);
  sendError(ws, message);
  ws.close(1008, 'Authentication failed');
}
function send(ws: WebSocket | null | undefined, msg: Record<string, unknown>): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const room = connections.get(ws)?.room;
  ws.send(JSON.stringify({ v: 1, ...msg, ...(room && versionedMetadata(msg.type)
    ? { roomGeneration: room.roomGeneration, roomRevision: room.engine.revision } : {}) }));
}
function notifyHost(room: Room, msg: Record<string, unknown>): void { send(room.host?.ws, msg); }
function publishFiles(room: Room, changes: FileTransition[], actor?: WebSocket): void {
  for (const change of changes) for (const effect of room.fileState.effects(change)) {
    if (effect.to === 'host') notifyHost(room, effect.message);
    else if (effect.to === 'actor') send(actor, effect.message);
    else {
      const owner = room.students.get(effect.ownerId!);
      if (owner?.approved) send(owner.ws, effect.message);
    }
  }
}
function students(room: Room): StudentInfo[] {
  return room.engine.students();
}
function acceptableText(s: unknown, limit = 100): string {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, limit) : '';
}
function validId(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(s);
}
function findRoom(joinToken?: string, code?: string): Room | undefined {
  return [...rooms.values()].find(r => (joinToken && r.joinToken === joinToken) || (code && r.code === code));
}
function validOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (process.env.PUBLIC_ORIGIN) return url.origin === new URL(process.env.PUBLIC_ORIGIN).origin;
    if (url.host === req.headers.host) return true;
    return process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      ['3000', '5173'].includes(url.port);
  } catch { return false; }
}
function removeStudent(peer: Peer, rejectedChanges?: FileTransition[]): void {
  const room = peer.room;
  if (room.students.get(peer.id) !== peer) return;
  room.students.delete(peer.id);
  const departure = rejectedChanges ?? room.engine.disconnect(peer.id, peer.ws)?.changes ?? [];
  publishFiles(room, departure);
  for (const [id, pending] of room.outstanding) {
    if (pending.senderId === peer.id) {
      room.outstanding.delete(id);
      notifyHost(room, { type: 'range.error', requestId: id, message: 'Sender disconnected' });
    }
  }
  notifyHost(room, { type: 'student.left', id: peer.id });
}
function closeRoom(room: Room): void {
  room.engine.clear();
  for (const peer of room.students.values()) {
    send(peer.ws, { type: 'room.closed' });
    peer.ws.close(1000, 'Room ended');
  }
  if (room.host) { send(room.host.ws, { type: 'room.closed' }); room.host.ws.close(1000, 'Room ended'); }
  room.students.clear();
  room.outstanding.clear();
  rooms.delete(room.id);
}

function handleHello(ws: WebSocket, msg: Record<string, unknown>): void {
  if (msg.role === 'host') {
    const room = rooms.get(String(msg.roomId ?? ''));
    if (!room || msg.token !== room.hostToken) return void rejectAuthentication(ws, 'Invalid host session');
    if (Date.now() >= roomExpiresAt(room.created, room.lastActivityAt)) {
      closeRoom(room);
      send(ws, { type: 'room.closed' });
      releasePending(ws);
      ws.close(1000, 'Room expired');
      return;
    }
    // A holder of the high-entropy host secret may replace an outdated connection
    // (e.g. refresh or reconnection before the browser's close event is processed).
    if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
      connections.delete(room.host.ws);
      room.host.ws.close(4000, 'Host reconnected');
    }
    const peer: Peer = { ws, id: randomUUID(), role: 'host', room, name: 'Host', approved: true };
    room.host = peer;
    room.engine.connectHost(ws);
    // Old receiver requests cannot complete into the replacement's callbacks.
    room.outstanding.clear();
    room.lastActivityAt = Date.now();
    connections.set(ws, peer);
    releasePending(ws);
    send(ws, {
      type: 'room.state', id: room.id, code: room.code, joinToken: room.joinToken,
      roomGeneration: room.roomGeneration, leaseToken: room.leaseToken,
      cacheId: roomCacheIdentity(room),
      students: students(room), files: [...room.files.values()], autoApprove: room.autoApprove,
    });
    for (const student of room.students.values()) send(student.ws, { type: 'host.online' });
    return;
  }
  if (msg.role === 'student') {
    const token = typeof msg.joinToken === 'string' ? msg.joinToken : undefined;
    const code = typeof msg.code === 'string' ? msg.code : undefined;
    const room = findRoom(token, code);
    if (!room) return void rejectAuthentication(ws, 'Room not found or expired');
    if (Date.now() >= roomExpiresAt(room.created, room.lastActivityAt)) {
      closeRoom(room);
      return void rejectAuthentication(ws, 'Room not found or expired');
    }
    const joined = room.engine.join({ connection: ws, id: randomUUID(), name: msg.name,
      resumeToken: msg.resumeToken, newToken: randomToken(32), autoApprove: room.autoApprove,
      hostOnline: room.host?.ws.readyState === WebSocket.OPEN, now: Date.now() });
    if (joined.kind === 'rejected') {
      releasePending(ws);
      if (joined.code === 'HOST_OFFLINE') { rejectAuthentication(ws, joined.message); return; }
      send(ws, { type: joined.retryable ? 'error' : 'join.rejected', code: joined.code,
        message: joined.message, retryable: joined.retryable, retryAfterMs: joined.retryAfterMs });
      ws.close(1008, 'Room admission limit'); return;
    }
    if (joined.displaced) {
      const old = joined.displaced as WebSocket; connections.delete(old); old.close(4000, 'Session resumed on another socket');
    }
    const participant = joined.participant;
    const peer: Peer = { ws, id: participant.id, role: 'student', room, name: participant.name, approved: participant.approved };
    room.students.set(peer.id, peer); connections.set(ws, peer); releasePending(ws);
    publishFiles(room, joined.changes);
    send(ws, { type: participant.approved ? (joined.resumed ? 'join.resumed' : 'join.accepted') : 'join.pending',
      integrityRequired: room.cacheVersion === 3, roomCode: room.code, resumeToken: participant.token,
      ...(joined.resumed ? { files: [...room.files.values()].filter(file => file.ownerId === peer.id) } : {}) });
    if (joined.resumed && room.host?.ws.readyState !== WebSocket.OPEN) send(ws, { type: 'host.offline' });
    if (joined.resumed) for (const [requestId, range] of room.outstanding) {
      if (range.senderId === peer.id && room.files.get(range.fileId)?.status === 'approved')
        send(ws, { type: 'range.request', requestId, fileId: range.fileId, begin: range.begin, end: range.end });
    }
    notifyHost(room, { type: joined.resumed || participant.approved ? 'student.updated' : 'student.pending',
      student: { id: peer.id, name: peer.name, approved: peer.approved } });
    return;
  }
  rejectAuthentication(ws, 'Invalid role');
}
function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}
function handleControl(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const pending = pendingAuth.get(ws);
  if (pending && Date.now() >= pending.deadline) {
    releasePending(ws); ws.terminate(); return;
  }
  if (msg.type === 'hello') {
    if (!connections.has(ws)) handleHello(ws, msg);
    else sendError(ws, 'Already authenticated');
    return;
  }
  const peer = connections.get(ws);
  if (!peer) return void rejectAuthentication(ws, 'Authentication required');
  const room = peer.room;
  if (!rooms.has(room.id)) return;
  if (Date.now() >= roomExpiresAt(room.created, room.lastActivityAt)) { closeRoom(room); return; }
  if (peer.role === 'host' ? room.host !== peer : room.students.get(peer.id) !== peer) return;
  if (peer.role === 'host' && room.host === peer) room.lastActivityAt = Date.now();
  if (msg.type === 'heartbeat.ping') return void send(ws, { type: 'heartbeat.pong' });
  if (msg.type === 'room.sync' && peer.role === 'host') {
    return void send(ws, {
      type: 'room.state', id: room.id, code: room.code, joinToken: room.joinToken,
      roomGeneration: room.roomGeneration, leaseToken: room.leaseToken,
      cacheId: roomCacheIdentity(room),
      students: students(room), files: [...room.files.values()], autoApprove: room.autoApprove,
    });
  }
  if (msg.type === 'file.sync' && peer.role === 'student') {
    send(ws, {
      type: 'file.manifest', integrityRequired: room.cacheVersion === 3, files: [...room.files.values()].filter(file => file.ownerId === peer.id),
      approved: peer.approved, roomCode: room.code, hostOnline: room.host?.ws.readyState === WebSocket.OPEN,
    });
    return;
  }
  if (peer.role === 'host') {
    if (msg.type === 'cache.progress') {
      const change = room.fileState.cacheProgress(msg.fileId, msg.bytes, msg.snapshot);
      if (change) publishFiles(room, [change], ws);
      return;
    }
    if (msg.type === 'student.accept' && typeof msg.studentId === 'string') {
      const result = room.engine.approve(msg.studentId);
      const student = room.students.get(msg.studentId);
      if (result && student) {
        student.approved = result.participant.approved;
        publishFiles(room, result.changes);
        send(student.ws, { type: 'join.accepted', integrityRequired: room.cacheVersion === 3, roomCode: room.code, resumeToken: result.participant.token });
        notifyHost(room, { type: 'student.updated', student: { id: student.id, name: student.name, approved: true } });
      }
    } else if (msg.type === 'student.reject' && typeof msg.studentId === 'string') {
      const result = room.engine.reject(msg.studentId);
      const student = room.students.get(msg.studentId);
      if (result && student) {
        connections.delete(student.ws); removeStudent(student, result.changes);
        send(student.ws, { type: 'join.rejected', roomGeneration: room.roomGeneration, roomRevision: room.engine.revision });
        student.ws.close(1008, 'Rejected');
      } else if (result) publishFiles(room, result.changes);
    } else if (msg.type === 'range.request') {
      const { requestId, fileId, begin, end } = msg;
      const file = typeof fileId === 'string' ? room.files.get(fileId) : undefined;
      if (!validId(requestId) || !file || file.status !== 'approved' ||
          !Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
          Number(begin) < 0 || Number(end) <= Number(begin) ||
          Number(end) > file.size || Number(end) - Number(begin) > MAX_RANGE_BYTES ||
          room.outstanding.size >= 48) {
        return void send(ws, { type: 'range.error', requestId, message: 'Invalid/unavailable file range' });
      }
      const sender = room.students.get(file.ownerId);
      if (!sender || !sender.approved || room.outstanding.has(requestId)) {
        return void send(ws, { type: 'range.error', requestId, message: 'Sender unavailable' });
      }
      room.outstanding.set(requestId, {
        fileId: file.fileId, senderId: sender.id, begin: Number(begin), end: Number(end), created: Date.now(),
      });
      send(sender.ws, { type: 'range.request', fileId, requestId, begin, end });
    } else if (msg.type === 'range.cancel' && typeof msg.requestId === 'string') {
      room.outstanding.delete(msg.requestId);
    } else if (msg.type === 'room.end') {
      closeRoom(room);
    }
    return;
  }
  if (!peer.approved) return void sendError(ws, 'Waiting for teacher approval');
  if (msg.type === 'preview.chunk') {
    const file = typeof msg.fileId === 'string' ? room.files.get(msg.fileId) : undefined;
    if (!file || file.ownerId !== peer.id || file.status !== 'approved' ||
        !Number.isSafeInteger(msg.part) || !Number.isSafeInteger(msg.total) ||
        Number(msg.part) < 0 || Number(msg.total) < 1 || Number(msg.total) > 80 ||
        Number(msg.part) >= Number(msg.total) ||
        typeof msg.data !== 'string' || msg.data.length < 1 || (msg.data.length > 7000 || (msg.data.length > 5000 && Number(msg.total) > 16)) ||
        !/^[a-zA-Z0-9+/=]+$/.test(msg.data)) return;
    notifyHost(room, {
      type: 'preview.chunk', fileId: file.fileId,
      part: msg.part, total: msg.total, data: msg.data,
    });
    return;
  }
  if (msg.type === 'file.offer') {
    const result = room.fileState.offer(peer, msg, room.cacheVersion === 3);
    if (result.kind === 'rejected') return void send(ws, {
      type: 'file.rejected', fileId: msg.fileId, code: result.code, message: result.message,
    });
    publishFiles(room, [result], ws);
  } else if (msg.type === 'range.error' && typeof msg.requestId === 'string') {
    const pending = room.outstanding.get(msg.requestId);
    if (pending?.senderId === peer.id) {
      room.outstanding.delete(msg.requestId);
      notifyHost(room, {
        type: 'range.error', requestId: msg.requestId,
        message: acceptableText(msg.message, 120) || 'Sender cannot provide PDF bytes',
      });
    }
  } else if (msg.type === 'file.revoke' && typeof msg.fileId === 'string') {
    const change = room.fileState.revoke(peer.id, msg.fileId);
    if (change) {
      for (const [id, pending] of room.outstanding) {
        if (pending.fileId === msg.fileId) {
          room.outstanding.delete(id);
          notifyHost(room, { type: 'range.error', requestId: id, message: 'File sharing stopped' });
        }
      }
      publishFiles(room, [change], ws);
    }
  }
}
function handleBinary(ws: WebSocket, raw: RawData): void {
  const sender = connections.get(ws);
  if (!sender || sender.role !== 'student' || !sender.approved) return;
  const room = sender.room;
  if (room.students.get(sender.id) !== sender) return;
  const buffer = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
  try {
    const { header, bytes } = decodeRangePacket(buffer.buffer.slice(
      buffer.byteOffset, buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer);
    const pending = room.outstanding.get(header.requestId);
    if (!pending || pending.senderId !== sender.id || pending.fileId !== header.fileId ||
        pending.begin !== header.begin || bytes.byteLength !== pending.end - pending.begin ||
        bytes.byteLength > MAX_RANGE_BYTES) return;
    room.outstanding.delete(header.requestId);
    const host = room.host?.ws;
    if (host?.readyState === WebSocket.OPEN && host.bufferedAmount < 4 * 1024 * 1024) {
      host.send(buffer, { binary: true });
    } else {
      notifyHost(room, { type: 'range.error', requestId: header.requestId, message: 'Receiver overloaded' });
    }
  } catch { /* Ignore malformed binary data without leaking document bytes to logs. */ }
}
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  let path: string;
  try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }
  const file = resolve(publicDir, '.' + (path === '/' ? '/index.html' : path));
  if (!(file === publicDir || file.startsWith(publicDir + sep))) { res.writeHead(403).end(); return; }
  const resolved = existsSync(file) && statSync(file).isFile() ? file : resolve(publicDir, 'index.html');
  if (!existsSync(resolved)) { res.writeHead(404).end('Run npm run build or npm run dev'); return; }
  res.setHeader('Content-Type', mime[extname(resolved)] ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  createReadStream(resolved).pipe(res);
}
async function handleRoomControl(req: IncomingMessage, res: ServerResponse, id: string,
  action: 'lease' | 'end'): Promise<void> {
  const reply = (data: unknown, status = 200) => res.writeHead(status, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  }).end(JSON.stringify(data));
  if (req.method !== 'POST') { reply({ error: 'POST required' }, 405); return; }
  if (req.headers.origin && !validOrigin(req)) { reply({ error: 'Forbidden origin' }, 403); return; }
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!validControlToken(token)) { reply({ error: 'Authorization required' }, 401); return; }
  if (req.headers['content-type'] !== 'application/json') { reply({ error: 'JSON required' }, 415); return; }
  const reader = Readable.toWeb(req).getReader();
  let generation: string;
  try { generation = await readRoomControlGeneration(reader); }
  catch (error) {
    reply({ error: 'Invalid control command' }, error instanceof RoomControlInputError ? error.status : 400);
    return;
  } finally { reader.releaseLock(); }
  const room = rooms.get(id);
  const decision = authorizeRoomControl(room ?? null, generation, token, action, Date.now());
  if (decision === 'denied') { reply({ error: 'Invalid capability' }, 403); return; }
  if (decision === 'absent') { reply({ roomGeneration: generation, state: 'absent' }); return; }
  if (decision === 'expired' || action === 'end') {
    closeRoom(room!);
    reply({ roomGeneration: generation, state: 'closed' });
    return;
  }
  room!.lastActivityAt = Date.now();
  reply({ roomGeneration: generation, state: 'active', expiresAt: roomExpiresAt(room!.created, room!.lastActivityAt) });
}

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  const control = /^\/api\/rooms\/([A-Za-z0-9_-]{6,80})\/(lease|end)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (control) {
    void handleRoomControl(req, res, control[1], control[2] as 'lease' | 'end').catch(() => {
      if (!res.headersSent) res.writeHead(503, { 'Cache-Control': 'no-store' }).end();
      else res.end();
    });
    return;
  }
  if (req.url?.startsWith('/api/rooms') && req.method === 'POST') {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/rooms') { res.writeHead(404).end(); return; }
    const autoApprove = url.searchParams.get('autoApprove') === '1';
    if (req.headers.origin && !validOrigin(req)) { res.writeHead(403).end(); return; }
    const ip = (req.socket.remoteAddress ?? 'unknown');
    const now = Date.now();
    const usage = roomCreationByIp.take(ip, now);
    if (!usage.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Retry-After': retryAfterSeconds(usage.retryAfterMs) })
        .end(JSON.stringify({ error: 'Room creation is temporarily limited for this connection. Please try again later.' }));
      return;
    }
    if (rooms.size >= MAX_ROOMS) { res.writeHead(503).end('Server at capacity'); return; }
    let code: string;
    do { code = String(randomInt(100_000, 1_000_000)); }
    while ([...rooms.values()].some(r => r.code === code));
    const engine = new RoomEngine(), fileState = engine.fileState;
    const room: Room = {
      id: randomUUID(), roomGeneration: randomUUID(), leaseToken: randomToken(32), code, joinToken: randomToken(20),
      hostToken: randomToken(32), created: now, lastActivityAt: now, autoApprove,
      cacheVersion: url.searchParams.get('cache') === '3' ? 3 : url.searchParams.get('cache') === '2' ? 2 : undefined,
      host: null, students: new Map(), files: fileState.files, fileState, engine, outstanding: new Map(),
    };
    rooms.set(room.id, room);
    res.writeHead(201, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    }).end(JSON.stringify({ roomId: room.id, code, joinToken: room.joinToken, hostToken: room.hostToken,
      roomGeneration: room.roomGeneration, leaseToken: room.leaseToken, autoApprove,
      cacheId: roomCacheIdentity(room) }));
    return;
  }
  if (req.url?.startsWith('/api/')) { res.writeHead(404).end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  serveStatic(req, res);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RANGE_BYTES + 4096, perMessageDeflate: false });
http.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws' || !validOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (pendingAuth.size >= MAX_PENDING_NODE || wss.clients.size >= MAX_NODE_SOCKETS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\n\r\n');
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  const timer = setTimeout(() => { releasePending(ws); ws.terminate(); }, AUTH_TIMEOUT_MS);
  timer.unref();
  pendingAuth.set(ws, { deadline: Date.now() + AUTH_TIMEOUT_MS, timer });
  // Browsers (especially phones in the OS file picker) can miss an occasional
  // protocol ping. Require several missed replies before terminating a peer.
  (ws as WebSocket & { missedPongs?: number }).missedPongs = 0;
  ws.on('pong', () => {
    (ws as WebSocket & { missedPongs?: number }).missedPongs = 0;
    const peer = connections.get(ws);
    // Only the current authenticated host can renew room lifetime.
    if (peer?.role === 'host' && peer.room.host === peer &&
        Date.now() < roomExpiresAt(peer.room.created, peer.room.lastActivityAt)) peer.room.lastActivityAt = Date.now();
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (pendingAuth.has(ws)) { rejectAuthentication(ws, 'Authentication required'); return; }
      handleBinary(ws, data); return;
    }
    try {
      const incoming = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (incoming.byteLength > 8192) return void sendError(ws, 'Message too large');
      const msg: unknown = JSON.parse(incoming.toString());
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error();
      handleControl(ws, msg as Record<string, unknown>);
    } catch {
      if (pendingAuth.has(ws)) rejectAuthentication(ws, 'Invalid message');
      else sendError(ws, 'Invalid message');
    }
  });
  ws.on('close', () => {
    releasePending(ws);
    const peer = connections.get(ws);
    if (!peer) return;
    connections.delete(ws);
    if (peer.role === 'host') {
      if (peer.room.host === peer) {
        peer.room.host = null;
        peer.room.engine.disconnectHost(ws);
        for (const student of peer.room.students.values()) send(student.ws, { type: 'host.offline' });
      }
    } else removeStudent(peer);
  });
  ws.on('error', () => {});
});
const housekeeping = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now >= roomExpiresAt(room.created, room.lastActivityAt)) { closeRoom(room); continue; }
    for (const [id, pending] of room.outstanding) {
      if (now - pending.created > RANGE_TIMEOUT_MS) {
        room.outstanding.delete(id);
        notifyHost(room, { type: 'range.error', requestId: id, message: 'Request timed out' });
      }
    }
  }
  for (const client of wss.clients) {
    const socket = client as WebSocket & { missedPongs?: number };
    const missed = socket.missedPongs ?? 0;
    // Five missed 10-second checks provide ~50 seconds' grace for mobile
    // suspension without keeping truly dead clients around forever.
    if (missed >= 5) { socket.terminate(); continue; }
    socket.missedPongs = missed + 1;
    socket.ping();
  }
  roomCreationByIp.prune(now);
}, 10_000);
housekeeping.unref();
http.listen(PORT, '0.0.0.0', () => console.log('FlashView listening on port ' + PORT));
