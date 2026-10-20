import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { roomExpiresAt } from '../shared/roomLifetime.js';
import { roomCacheIdentity } from '../shared/roomCacheIdentity.js';
import { admitFile, admitSender } from '../shared/roomAdmission.js';
import { resumeDisconnectedFile, revokeFile } from '../shared/fileLifecycle.js';
import { authorizeRoomControl, readRoomControlGeneration, RoomControlInputError, validControlToken } from '../shared/roomControl.js';
import {
  decodeRangePacket, MAX_RANGE_BYTES, RANGE_TIMEOUT_MS, ROOM_TTL_MS,
  type PdfManifest, type StudentInfo,
} from '../shared/protocol.js';

type Role = 'host' | 'student';
type Peer = { ws: WebSocket; id: string; role: Role; room: Room; approved: boolean; name: string };
type ResumeSession = { id: string; name: string; approved: boolean; token: string };
type Outstanding = { fileId: string; senderId: string; begin: number; end: number; created: number };
type Room = {
  id: string; code: string; joinToken: string; hostToken: string; roomGeneration: string; leaseToken: string;
  autoApprove: boolean; cacheVersion?: 2;
  created: number; lastActivityAt: number; host: Peer | null; students: Map<string, Peer>;
  sessions: Map<string, ResumeSession>;
  files: Map<string, PdfManifest>; outstanding: Map<string, Outstanding>;
};
const rooms = new Map<string, Room>();
const connections = new WeakMap<WebSocket, Peer>();
const roomCreationByIp = new Map<string, { count: number; reset: number }>();
const MAX_ROOMS = 100;
const PORT = Number(process.env.PORT ?? 3000);
const publicDir = resolve(process.cwd(), 'dist');

function randomToken(bytes = 24): string { return randomBytes(bytes).toString('base64url'); }
function send(ws: WebSocket | null | undefined, msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, ...msg }));
}
function notifyHost(room: Room, msg: Record<string, unknown>): void { send(room.host?.ws, msg); }
function students(room: Room): StudentInfo[] {
  return [...room.students.values()].map(p => ({ id: p.id, name: p.name, approved: p.approved }));
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
function removeStudent(peer: Peer): void {
  const room = peer.room;
  if (room.students.get(peer.id) !== peer) return;
  room.students.delete(peer.id);
  for (const file of room.files.values()) {
    if (file.ownerId === peer.id && file.status === 'approved') {
      file.status = 'offline';
      notifyHost(room, { type: 'file.updated', file });
    }
  }
  for (const [id, pending] of room.outstanding) {
    if (pending.senderId === peer.id) {
      room.outstanding.delete(id);
      notifyHost(room, { type: 'range.error', requestId: id, message: 'Sender disconnected' });
    }
  }
  notifyHost(room, { type: 'student.left', id: peer.id });
}
function closeRoom(room: Room): void {
  for (const peer of room.students.values()) {
    send(peer.ws, { type: 'room.closed' });
    peer.ws.close(1000, 'Room ended');
  }
  if (room.host) { send(room.host.ws, { type: 'room.closed' }); room.host.ws.close(1000, 'Room ended'); }
  room.students.clear();
  room.sessions.clear();
  room.files.clear();
  room.outstanding.clear();
  rooms.delete(room.id);
}

function handleHello(ws: WebSocket, msg: Record<string, unknown>): void {
  if (msg.role === 'host') {
    const room = rooms.get(String(msg.roomId ?? ''));
    if (!room || msg.token !== room.hostToken) return void sendError(ws, 'Invalid host session');
    if (Date.now() >= roomExpiresAt(room.created, room.lastActivityAt)) {
      closeRoom(room);
      send(ws, { type: 'room.closed' });
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
    // Old receiver requests cannot complete into the replacement's callbacks.
    room.outstanding.clear();
    room.lastActivityAt = Date.now();
    connections.set(ws, peer);
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
    if (!room) return void sendError(ws, 'Room not found or expired');
    if (Date.now() >= roomExpiresAt(room.created, room.lastActivityAt)) {
      closeRoom(room);
      return void sendError(ws, 'Room not found or expired');
    }
    const previous = typeof msg.resumeToken === 'string'
      ? room.sessions.get(msg.resumeToken) : undefined;
    const admission = admitSender(room.students.size, room.sessions.size, Boolean(previous),
      Boolean(previous && room.students.has(previous.id)));
    if (admission.kind === 'rejected') {
      send(ws, { type: admission.retryable ? 'error' : 'join.rejected', code: admission.code,
        message: admission.message, retryable: admission.retryable });
      ws.close(1008, 'Room admission limit');
      return;
    }
    if (previous) {
      const oldPeer = room.students.get(previous.id);
      if (oldPeer) {
        connections.delete(oldPeer.ws);
        oldPeer.ws.close(4000, 'Session resumed on another socket');
      }
      const peer: Peer = {
        ws, id: previous.id, role: 'student', room,
        name: previous.name, approved: previous.approved,
      };
      room.students.set(peer.id, peer);
      connections.set(ws, peer);
      const ownFiles = [...room.files.values()].filter(f => f.ownerId === peer.id);
      for (const file of ownFiles) {
        if (resumeDisconnectedFile(file, previous.approved)) {
          notifyHost(room, { type: 'file.updated', file });
        }
      }
      send(ws, {
        type: previous.approved ? 'join.resumed' : 'join.pending',
        roomCode: room.code, resumeToken: previous.token, files: ownFiles,
      });
      if (!room.host || room.host.ws.readyState !== WebSocket.OPEN)
        send(ws, { type: 'host.offline' });
      // A suspended socket can still look OPEN at the relay. Its outstanding
      // requests belong to this same authenticated sender, so deliver them to
      // the replacement after its manifest, preserving IDs and deadlines.
      for (const [requestId, range] of room.outstanding) {
        if (range.senderId === peer.id && room.files.get(range.fileId)?.status === 'approved')
          send(ws, { type: 'range.request', requestId, fileId: range.fileId, begin: range.begin, end: range.end });
      }
      notifyHost(room, { type: 'student.updated', student: { id: peer.id, name: peer.name, approved: peer.approved } });
      return;
    }
    if (!room.host || room.host.ws.readyState !== WebSocket.OPEN) {
      return void sendError(ws, 'The host is offline');
    }
    const approved = room.autoApprove;
    const peer: Peer = {
      ws, id: randomUUID(), role: 'student', room,
      name: acceptableText(msg.name, 32) || 'Student', approved,
    };
    const resumeToken = typeof msg.resumeToken === 'string' && /^[a-f0-9]{64}$/.test(msg.resumeToken)
      ? msg.resumeToken : randomToken(32);
    room.sessions.set(resumeToken, { id: peer.id, token: resumeToken, name: peer.name, approved });
    room.students.set(peer.id, peer);
    connections.set(ws, peer);
    send(ws, { type: approved ? 'join.accepted' : 'join.pending', roomCode: room.code, resumeToken });
    notifyHost(room, {
      type: approved ? 'student.updated' : 'student.pending',
      student: { id: peer.id, name: peer.name, approved },
    });
    return;
  }
  sendError(ws, 'Invalid role');
}
function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}
function handleControl(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (msg.type === 'hello') {
    if (!connections.has(ws)) handleHello(ws, msg);
    else sendError(ws, 'Already authenticated');
    return;
  }
  const peer = connections.get(ws);
  if (!peer) return void sendError(ws, 'Authentication required');
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
  if (msg.type === 'file.sync' && peer.role === 'student' && peer.approved) {
    send(ws, {
      type: 'file.manifest', files: [...room.files.values()].filter(file => file.ownerId === peer.id),
    });
    return;
  }
  if (peer.role === 'host') {
    if (msg.type === 'cache.progress') {
      const file = typeof msg.fileId === 'string' ? room.files.get(msg.fileId) : undefined;
      const bytes = msg.bytes;
      // Only a finished PDF deserves network metadata. Older hosts may
      // still send intermediate cache.progress events: ignore them entirely.
      // Explicit zero snapshots repair a stale completion after host storage loss.
      if (file && Number.isSafeInteger(bytes) &&
          (bytes === file.size || (msg.snapshot === true && bytes === 0))) {
        const next = Number(bytes);
        if (file.cachedBytes !== next) {
          file.cachedBytes = next;
          const student = room.students.get(file.ownerId);
          if (student && student.approved) send(student.ws, {
            type: 'cache.progress', fileId: file.fileId, bytes: next,
            size: file.size, complete: next === file.size,
          });
        }
        // A duplicate finished-file notice is a retry, not a new download.
        // Always receipt it, even if the previous receipt was lost.
        if (next === file.size)
          send(ws, { type: 'cache.progress.receipt', fileId: file.fileId, bytes: next });
      }
      return;
    }
    if (msg.type === 'student.accept' && typeof msg.studentId === 'string') {
      const student = room.students.get(msg.studentId);
      if (student) {
        student.approved = true;
        for (const file of room.files.values()) {
          if (file.ownerId === student.id && file.status === 'pending') {
            file.status = 'approved';
            notifyHost(room, { type: 'file.updated', file });
          }
        }
        const session = [...room.sessions.values()].find(record => record.id === student.id);
        if (session) session.approved = true;
        send(student.ws, { type: 'join.accepted', roomCode: room.code, resumeToken: session?.token });
        notifyHost(room, { type: 'student.updated', student: { id: student.id, name: student.name, approved: true } });
      }
    } else if (msg.type === 'student.reject' && typeof msg.studentId === 'string') {
      const student = room.students.get(msg.studentId);
      if (student) {
        for (const [key, record] of room.sessions) if (record.id === student.id) room.sessions.delete(key);
        // Retire authority and release the place before waiting for a close
        // handshake. A suspended phone may not acknowledge closure promptly.
        connections.delete(student.ws);
        removeStudent(student);
        send(student.ws, { type: 'join.rejected' });
        student.ws.close(1008, 'Rejected');
      }
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
    const result = admitFile(room.files, peer, msg);
    if (result.kind === 'rejected') return void send(ws, {
      type: 'file.rejected', fileId: msg.fileId, code: result.code, message: result.message,
    });
    if (result.kind === 'created') {
      notifyHost(room, { type: 'file.announced', file: result.file });
      send(ws, { type: 'file.approved', fileId: result.file.fileId });
    } else if (result.kind === 'updated') notifyHost(room, { type: 'file.updated', file: result.file });
    send(ws, { type: 'file.state', file: result.file });
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
    const file = room.files.get(msg.fileId);
    if (file?.ownerId === peer.id) {
      revokeFile(file);
      for (const [id, pending] of room.outstanding) {
        if (pending.fileId === msg.fileId) {
          room.outstanding.delete(id);
          notifyHost(room, { type: 'range.error', requestId: id, message: 'File sharing stopped' });
        }
      }
      notifyHost(room, { type: 'file.updated', file });
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
    const ip = (req.socket.remoteAddress ?? 'unknown');
    const now = Date.now();
    const usage = roomCreationByIp.get(ip);
    if (usage && usage.reset > now && usage.count >= 20) {
      res.writeHead(429).end('Too many rooms'); return;
    }
    roomCreationByIp.set(ip, usage?.reset && usage.reset > now
      ? { count: usage.count + 1, reset: usage.reset }
      : { count: 1, reset: now + 60 * 60 * 1000 });
    if (rooms.size >= MAX_ROOMS) { res.writeHead(503).end('Server at capacity'); return; }
    let code: string;
    do { code = String(randomInt(100_000, 1_000_000)); }
    while ([...rooms.values()].some(r => r.code === code));
    const room: Room = {
      id: randomUUID(), roomGeneration: randomUUID(), leaseToken: randomToken(32), code, joinToken: randomToken(20),
      hostToken: randomToken(32), created: now, lastActivityAt: now, autoApprove,
      cacheVersion: url.searchParams.get('cache') === '2' ? 2 : undefined,
      host: null, students: new Map(), sessions: new Map(), files: new Map(), outstanding: new Map(),
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
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
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
    if (isBinary) { handleBinary(ws, data); return; }
    try {
      const incoming = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (incoming.byteLength > 8192) return void sendError(ws, 'Message too large');
      const msg: unknown = JSON.parse(incoming.toString());
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error();
      handleControl(ws, msg as Record<string, unknown>);
    } catch { sendError(ws, 'Invalid message'); }
  });
  ws.on('close', () => {
    const peer = connections.get(ws);
    if (!peer) return;
    connections.delete(ws);
    if (peer.role === 'host') {
      if (peer.room.host === peer) {
        peer.room.host = null;
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
  for (const [ip, entry] of roomCreationByIp) if (entry.reset < now) roomCreationByIp.delete(ip);
}, 10_000);
housekeeping.unref();
http.listen(PORT, '0.0.0.0', () => console.log('FlashView listening on port ' + PORT));
