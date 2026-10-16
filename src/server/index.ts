import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  decodeRangePacket, MAX_PDF_BYTES, MAX_RANGE_BYTES, RANGE_TIMEOUT_MS, ROOM_TTL_MS,
  type PdfManifest, type StudentInfo,
} from '../shared/protocol.js';

type Role = 'host' | 'student';
type Peer = { ws: WebSocket; id: string; role: Role; room: Room; approved: boolean; name: string };
type ResumeSession = { id: string; name: string; approved: boolean; token: string };
type Outstanding = { fileId: string; senderId: string; begin: number; end: number; created: number };
type Room = {
  id: string; code: string; joinToken: string; hostToken: string;
  created: number; host: Peer | null; students: Map<string, Peer>;
  sessions: Map<string, ResumeSession>;
  files: Map<string, PdfManifest>; outstanding: Map<string, Outstanding>;
};
const rooms = new Map<string, Room>();
const connections = new WeakMap<WebSocket, Peer>();
const roomCreationByIp = new Map<string, { count: number; reset: number }>();
const MAX_ROOMS = 100;
const MAX_STUDENTS = 30;
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
    // A holder of the high-entropy host secret may replace an outdated connection
    // (e.g. refresh or reconnection before the browser's close event is processed).
    if (room.host && room.host.ws.readyState === WebSocket.OPEN) {
      room.host.ws.close(4000, 'Host reconnected');
    }
    const peer: Peer = { ws, id: randomUUID(), role: 'host', room, name: 'Host', approved: true };
    room.host = peer;
    connections.set(ws, peer);
    send(ws, {
      type: 'room.state', id: room.id, code: room.code, joinToken: room.joinToken,
      students: students(room), files: [...room.files.values()],
    });
    return;
  }
  if (msg.role === 'student') {
    const token = typeof msg.joinToken === 'string' ? msg.joinToken : undefined;
    const code = typeof msg.code === 'string' ? msg.code : undefined;
    const room = findRoom(token, code);
    if (!room) return void sendError(ws, 'Room not found or expired');
    if (!room.host || room.host.ws.readyState !== WebSocket.OPEN) {
      return void sendError(ws, 'The host is offline');
    }
    const previous = typeof msg.resumeToken === 'string'
      ? room.sessions.get(msg.resumeToken) : undefined;
    if (previous) {
      const oldPeer = room.students.get(previous.id);
      if (oldPeer) oldPeer.ws.close(4000, 'Session resumed on another socket');
      const peer: Peer = {
        ws, id: previous.id, role: 'student', room,
        name: previous.name, approved: previous.approved,
      };
      room.students.set(peer.id, peer);
      connections.set(ws, peer);
      const ownFiles = [...room.files.values()].filter(f => f.ownerId === peer.id);
      for (const file of ownFiles) {
        if (file.status === 'offline') {
          file.status = previous.approved ? 'approved' : 'pending';
          notifyHost(room, { type: 'file.updated', file });
        }
      }
      send(ws, {
        type: previous.approved ? 'join.resumed' : 'join.pending',
        roomCode: room.code, resumeToken: previous.token, files: ownFiles,
      });
      notifyHost(room, { type: 'student.updated', student: { id: peer.id, name: peer.name, approved: peer.approved } });
      return;
    }
    if (room.students.size >= MAX_STUDENTS) return void sendError(ws, 'Room is full');
    const peer: Peer = {
      ws, id: randomUUID(), role: 'student', room,
      name: acceptableText(msg.name, 32) || 'Student', approved: false,
    };
    const resumeToken = randomToken(32);
    room.sessions.set(resumeToken, { id: peer.id, token: resumeToken, name: peer.name, approved: false });
    room.students.set(peer.id, peer);
    connections.set(ws, peer);
    send(ws, { type: 'join.pending', roomCode: room.code, resumeToken });
    notifyHost(room, { type: 'student.pending', student: { id: peer.id, name: peer.name, approved: false } });
    return;
  }
  sendError(ws, 'Invalid role');
}
function sendError(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}
function handleControl(ws: WebSocket, msg: Record<string, unknown>): void {
  if (msg.type === 'hello') {
    if (!connections.has(ws)) handleHello(ws, msg);
    else sendError(ws, 'Already authenticated');
    return;
  }
  const peer = connections.get(ws);
  if (!peer) return void sendError(ws, 'Authentication required');
  const room = peer.room;
  if (msg.type === 'heartbeat.ping') return void send(ws, { type: 'heartbeat.pong' });
  if (peer.role === 'host') {
    if (msg.type === 'student.accept' && typeof msg.studentId === 'string') {
      const student = room.students.get(msg.studentId);
      if (student) {
        student.approved = true;
        const session = [...room.sessions.values()].find(record => record.id === student.id);
        if (session) session.approved = true;
        send(student.ws, { type: 'join.accepted', roomCode: room.code, resumeToken: session?.token });
        notifyHost(room, { type: 'student.updated', student: { id: student.id, name: student.name, approved: true } });
      }
    } else if (msg.type === 'student.reject' && typeof msg.studentId === 'string') {
      const student = room.students.get(msg.studentId);
      if (student) {
        for (const [key, record] of room.sessions) if (record.id === student.id) room.sessions.delete(key);
        send(student.ws, { type: 'join.rejected' });
        student.ws.close(1008, 'Rejected');
      }
    } else if (msg.type === 'file.approve' && typeof msg.fileId === 'string') {
      const file = room.files.get(msg.fileId);
      const sender = file && room.students.get(file.ownerId);
      if (file?.status === 'pending' && sender?.approved) {
        file.status = 'approved';
        send(sender.ws, { type: 'file.approved', fileId: file.fileId });
        notifyHost(room, { type: 'file.updated', file });
      }
    } else if (msg.type === 'file.reject' && typeof msg.fileId === 'string') {
      const file = room.files.get(msg.fileId);
      if (file?.status === 'pending') {
        file.status = 'rejected';
        send(room.students.get(file.ownerId)?.ws, { type: 'file.rejected', fileId: file.fileId });
        notifyHost(room, { type: 'file.updated', file });
      }
    } else if (msg.type === 'range.request') {
      const { requestId, fileId, begin, end } = msg;
      const file = typeof fileId === 'string' ? room.files.get(fileId) : undefined;
      if (!validId(requestId) || !file || file.status !== 'approved' ||
          !Number.isSafeInteger(begin) || !Number.isSafeInteger(end) ||
          Number(begin) < 0 || Number(end) <= Number(begin) ||
          Number(end) > file.size || Number(end) - Number(begin) > MAX_RANGE_BYTES ||
          room.outstanding.size >= 48) {
        return void send(ws, { type: 'range.error', requestId, message: 'Invalid/unavailable PDF range' });
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
  if (msg.type === 'file.offer') {
    const fileId = msg.fileId;
    const size = msg.size;
    if (!validId(fileId) || !Number.isSafeInteger(size) ||
        Number(size) <= 0 || Number(size) > MAX_PDF_BYTES ||
        room.files.has(fileId) || [...room.files.values()].filter(f => f.ownerId === peer.id).length >= 10) {
      return void sendError(ws, 'Invalid PDF file or room file limit reached');
    }
    const name = acceptableText(msg.name, 130) || 'Document.pdf';
    if (!name.toLowerCase().endsWith('.pdf')) return void sendError(ws, 'PDF files only');
    const file: PdfManifest = {
      fileId, name, size: Number(size), ownerId: peer.id, ownerName: peer.name, status: 'pending',
    };
    room.files.set(fileId, file);
    notifyHost(room, { type: 'file.announced', file });
    send(ws, { type: 'file.pending', fileId });
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
      file.status = 'offline';
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
const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/rooms' && req.method === 'POST') {
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
      id: randomUUID(), code, joinToken: randomToken(20),
      hostToken: randomToken(32), created: now,
      host: null, students: new Map(), sessions: new Map(), files: new Map(), outstanding: new Map(),
    };
    rooms.set(room.id, room);
    res.writeHead(201, {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    }).end(JSON.stringify({ roomId: room.id, code, joinToken: room.joinToken, hostToken: room.hostToken }));
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
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on('pong', () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });
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
    if (now - room.created > ROOM_TTL_MS) { closeRoom(room); continue; }
    for (const [id, pending] of room.outstanding) {
      if (now - pending.created > RANGE_TIMEOUT_MS) {
        room.outstanding.delete(id);
        notifyHost(room, { type: 'range.error', requestId: id, message: 'Request timed out' });
      }
    }
  }
  for (const client of wss.clients) {
    const socket = client as WebSocket & { isAlive?: boolean };
    if (socket.isAlive === false) { socket.terminate(); continue; }
    socket.isAlive = false; socket.ping();
  }
  for (const [ip, entry] of roomCreationByIp) if (entry.reset < now) roomCreationByIp.delete(ip);
}, 10_000);
housekeeping.unref();
http.listen(PORT, '0.0.0.0', () => console.log('FlashView listening on port ' + PORT));
