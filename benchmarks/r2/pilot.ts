import { DurableObject } from 'cloudflare:workers';
import { signCapability, verifyCapability, type Capability } from '../capability';
import type { Env } from './worker';

type OfferedFile = {
  id: string; name: string; size: number; hashes: string[];
  hashBlockBytes: number; partBytes: number; offeredAt: number; published?: boolean;
};
type Pilot = { id: string; expiresAt: number; files: OfferedFile[] };
const MAX_TOTAL = 512 * 1024 * 1024;
const PART_BYTES = 5 * 1024 * 1024;
const HASH_BYTES = 8 * 1024 * 1024;
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
});

/** Bounded manual-test invitation, deliberately not production room state. */
export class BenchmarkPilot extends DurableObject<Env> {
  async initialize(id: string): Promise<number> {
    const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
    await this.ctx.storage.put('pilot', { id, expiresAt, files: [] } satisfies Pilot);
    await this.ctx.storage.setAlarm(expiresAt);
    return expiresAt;
  }
  private async pilot(): Promise<Pilot> {
    const pilot = await this.ctx.storage.get<Pilot>('pilot');
    if (!pilot || pilot.expiresAt <= Date.now()) throw Error('Pilot expired');
    return pilot;
  }
  async offer(input: { name: string; size: number; hashes: string[]; hashBlockBytes: number }): Promise<OfferedFile> {
    const file: OfferedFile = { ...input, id: crypto.randomUUID(), partBytes: PART_BYTES, offeredAt: Date.now() };
    const expiresAt = await this.ctx.storage.transaction(async tx => {
      const pilot = await tx.get<Pilot>('pilot');
      if (!pilot || pilot.expiresAt <= Date.now()) throw Error('Pilot expired');
      if (pilot.files.length >= 10 || pilot.files.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_TOTAL)
        throw Error('Pilot limit reached');
      pilot.files.push(file); // Reserve before creating cloud storage, including failed admissions.
      await tx.put('pilot', pilot);
      return pilot.expiresAt;
    });
    await this.env.RUNS.getByName(file.id).initialize(file.id, file.size, PART_BYTES, 'object', undefined, expiresAt);
    await this.ctx.storage.transaction(async tx => {
      const pilot = await tx.get<Pilot>('pilot');
      if (!pilot || pilot.expiresAt <= Date.now()) throw Error('Pilot expired');
      pilot.files.find(item => item.id === file.id)!.published = true;
      await tx.put('pilot', pilot);
    });
    return file;
  }
  async snapshot(role: 'host' | 'sender', origin: string): Promise<unknown> {
    const pilot = await this.pilot();
    const files = await Promise.all(pilot.files.filter(file => file.published).map(async file => ({
      ...file,
      ...await this.env.RUNS.getByName(file.id).snapshot(),
      token: await signCapability(this.env.BENCH_TOKEN, {
        id: file.id, role: role === 'host' ? 'reader' : 'writer', expiresAt: pilot.expiresAt,
      }),
    })));
    return { expiresAt: pilot.expiresAt, files, ...(role === 'host' ? {
      senderUrl: origin + '/#' + new URLSearchParams({ pilot: pilot.id, role: 'sender',
        key: await signCapability(this.env.BENCH_TOKEN, { id: pilot.id, role: 'sender', expiresAt: pilot.expiresAt }),
      }),
    } : {}) };
  }
  async alarm(): Promise<void> {
    const pilot = await this.ctx.storage.get<Pilot>('pilot');
    if (!pilot) return;
    // Do not delete room metadata until every run has a durable deleting marker.
    await Promise.all(pilot.files.map(file => this.env.RUNS.getByName(file.id).remove()));
    await this.ctx.storage.deleteAll();
  }
}

export async function pilotRoute(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/pilots' && request.method === 'POST') {
    if (request.headers.get('Authorization') !== 'Bearer ' + env.BENCH_TOKEN) return json({ error: 'Unauthorized' }, 401);
    const id = crypto.randomUUID();
    const expiresAt = await env.PILOTS.getByName(id).initialize(id);
    const token = await signCapability(env.BENCH_TOKEN, { id, role: 'host', expiresAt });
    return json({ id, expiresAt, hostUrl: url.origin + '/#' + new URLSearchParams({ pilot: id, role: 'host', key: token }) }, 201);
  }
  const match = /^\/api\/pilots\/([0-9a-f-]{36})(\/runs)?$/.exec(url.pathname);
  const claims: Capability | null = await verifyCapability(env.BENCH_TOKEN,
    request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '');
  if (!match || !claims || claims.id !== match[1] || !['host', 'sender'].includes(claims.role))
    return json({ error: 'Invite expired or invalid' }, 401);
  const pilot = env.PILOTS.getByName(match[1]);
  if (request.method === 'GET' && !match[2]) return json(await pilot.snapshot(claims.role as 'host' | 'sender', url.origin));
  if (request.method === 'POST' && match[2] && claims.role === 'sender') {
    if (request.headers.get('Content-Type') !== 'application/json') return json({ error: 'JSON required' }, 415);
    // Bound decoded metadata even when Content-Length is absent or false.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Metadata required' }, 400);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 8192) { await reader.cancel(); return json({ error: 'Metadata too large' }, 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const input = JSON.parse(new TextDecoder().decode(bytes)) as OfferedFile;
    if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 255 ||
        !Number.isSafeInteger(input.size) || input.size < 1 || input.size > 200 * 1024 * 1024 ||
        input.hashBlockBytes !== HASH_BYTES || !Array.isArray(input.hashes) ||
        input.hashes.length !== Math.ceil(input.size / HASH_BYTES) ||
        input.hashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))
      return json({ error: 'Invalid file metadata' }, 400);
    const file = await pilot.offer({ name: input.name, size: input.size, hashes: input.hashes, hashBlockBytes: HASH_BYTES });
    return json({ ...file, token: await signCapability(env.BENCH_TOKEN, {
      id: file.id, role: 'writer', expiresAt: claims.expiresAt,
    }) }, 201);
  }
  return json({ error: 'Role cannot perform this operation' }, 403);
}
