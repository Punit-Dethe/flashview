/** Isolated experiment, deliberately separate from production room routes.
 * BENCH_TOKEN is mandatory; no unauthenticated cloud mutations are allowed.
 * This is not the production admission/authentication or retry implementation.
 */
import { DurableObject } from 'cloudflare:workers';
import { verifyCapability } from '../capability';
import { pilotRoute, BenchmarkPilot } from './pilot';
export { BenchmarkPilot };

export interface Env {
  FILES: R2Bucket;
  RUNS: DurableObjectNamespace<BenchmarkRun>;
  PILOTS: DurableObjectNamespace<BenchmarkPilot>;
  ASSETS: Fetcher;
  BENCH_TOKEN: string;
}
type Run = {
  id: string; key: string; size: number; partBytes: number;
  uploadId?: string; parts: Record<string, R2UploadedPart>;
  layout?: 'object' | 'segments'; partHashes?: string[];
  state: 'uploading' | 'committing' | 'ready' | 'deleting';
  cleanupPasses?: number;
  uploadedAt?: number;
};
const MAX_BYTES = 200 * 1024 * 1024;
const response = (data: unknown, status = 200, timings?: Record<string, number>) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', ...(timings ? {
    'Server-Timing': Object.entries(timings).map(([name, ms]) => name + ';dur=' + ms.toFixed(2)).join(', '),
  } : {}) },
});

export class BenchmarkRun extends DurableObject<Env> {
  private async run(): Promise<Run> {
    const run = await this.ctx.storage.get<Run>('run');
    if (!run) throw Error('Unknown benchmark run');
    return run;
  }
  async initialize(id: string, size: number, partBytes: number,
    layout: 'object' | 'segments' = 'object', partHashes?: string[], expiresAt?: number): Promise<void> {
    const key = 'benchmark/' + id + '/original';
    const run: Run = { id, key, size, partBytes, parts: {}, state: 'uploading', layout, partHashes };
    // Record intent before any external storage allocation.
    await this.ctx.storage.put('run', run);
    await this.ctx.storage.setAlarm(expiresAt ?? Date.now() + 30 * 60 * 1000);
    if (layout === 'object' && size > partBytes) {
      const upload = await this.env.FILES.createMultipartUpload(key);
      run.uploadId = upload.uploadId;
      await this.ctx.storage.put('run', run);
    }
  }
  async authorizePart(part: number): Promise<{ key: string; uploadId?: string; length: number; sha256?: string }> {
    const run = await this.run();
    const count = Math.ceil(run.size / run.partBytes);
    if (run.state !== 'uploading' || !Number.isInteger(part) || part < 1 || part > count || run.parts[part])
      throw Error('Part is unavailable');
    return { key: run.layout === 'segments' ? run.key + '/' + part : run.key,
      uploadId: run.uploadId, sha256: run.partHashes?.[part - 1],
      length: Math.min(run.partBytes, run.size - (part - 1) * run.partBytes) };
  }
  async recordPart(part: R2UploadedPart): Promise<void> {
    const run = await this.run();
    if (run.state !== 'uploading') throw Error('Upload is no longer active');
    run.parts[part.partNumber] = part;
    await this.ctx.storage.put('run', run);
  }
  async finalize(): Promise<{ size: number; etag: string }> {
    const run = await this.run();
    if (run.state === 'deleting') throw Error('Run ended');
    const count = Math.ceil(run.size / run.partBytes);
    if (Array.from({ length: count }, (_, index) => run.parts[index + 1]).some(part => !part))
      throw Error('Missing uploaded parts');
    if (run.layout === 'segments') {
      run.state = 'ready';
      run.uploadedAt ??= Date.now();
      await this.ctx.storage.put('run', run);
      return { size: run.size, etag: '"' + run.id + '"' };
    }
    if (run.state !== 'ready') {
      const wasCommitting = run.state === 'committing';
      run.state = 'committing';
      await this.ctx.storage.put('run', run);
      // HEAD reconciles completion that succeeded before its response was lost.
      const completed = wasCommitting ? await this.env.FILES.head(run.key) : null;
      if (run.uploadId && !completed)
        await this.env.FILES.resumeMultipartUpload(run.key, run.uploadId)
          .complete(Array.from({ length: count }, (_, index) => run.parts[index + 1]));
      const object = await this.env.FILES.head(run.key);
      if (!object || object.size !== run.size) throw Error('Original length verification failed');
      run.state = 'ready';
      run.uploadedAt ??= Date.now();
      await this.ctx.storage.put('run', run);
      return { size: object.size, etag: object.httpEtag };
    }
    const object = await this.env.FILES.head(run.key);
    if (!object || object.size !== run.size) throw Error('Original unavailable');
    return { size: object.size, etag: object.httpEtag };
  }
  async snapshot(): Promise<{ state: Run['state']; parts: number[]; uploadedAt?: number }> {
    const run = await this.run();
    return { state: run.state, parts: Object.keys(run.parts).map(Number), uploadedAt: run.uploadedAt };
  }
  async readableKey(part?: number): Promise<string> {
    const run = await this.run();
    if (run.layout === 'segments') {
      if (run.state === 'deleting' || !Number.isInteger(part) || !run.parts[part!])
        throw Error('Segment is not committed');
      return run.key + '/' + part;
    }
    if (run.state !== 'ready') throw Error('Original is not committed');
    return run.key;
  }
  async remove(): Promise<void> {
    const run = await this.ctx.storage.get<Run>('run');
    if (!run) return;
    run.state = 'deleting';
    await this.ctx.storage.put('run', run);
    // Retain a tombstone and sweep again: an earlier in-flight write can land
    // after deletion. The benchmark's final explicit cleanup follows all tasks.
    run.cleanupPasses = (run.cleanupPasses ?? 0) + 1;
    await this.ctx.storage.put('run', run);
    if (run.uploadId) {
      try { await this.env.FILES.resumeMultipartUpload(run.key, run.uploadId).abort(); }
      catch { /* Completed or previously aborted; object deletion still required. */ }
    }
    await this.env.FILES.delete(run.layout === 'segments'
      ? Array.from({ length: Math.ceil(run.size / run.partBytes) }, (_, index) => run.key + '/' + (index + 1))
      : run.key);
    if (run.cleanupPasses >= 3) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }
  async alarm(): Promise<void> {
    await this.remove();
    // Bounded extra sweeps; production also reconciles uncertain late writes.
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return response({ ok: true, experiment: 'r2' });
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.BENCH_TOKEN || env.BENCH_TOKEN.length < 32) return response({ error: 'Benchmark token required' }, 503);
    try {
      if (url.pathname.startsWith('/api/pilots')) return await pilotRoute(request, env);
      const admin = request.headers.get('Authorization') === 'Bearer ' + env.BENCH_TOKEN;
      const claims = admin ? null : await verifyCapability(env.BENCH_TOKEN,
        request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '');
      const scoped = /^\/api\/runs\/([0-9a-f-]{36})(?:\/(parts\/[1-9]\d*|complete|file))?$/.exec(url.pathname);
      if (!admin && (!claims || !scoped || claims.id !== scoped[1] ||
          !(claims.role === 'reader' && request.method === 'GET' ||
            claims.role === 'writer' && (request.method === 'GET' && !scoped[2] ||
              request.method === 'PUT' && scoped[2]?.startsWith('parts/') ||
              request.method === 'POST' && scoped[2] === 'complete'))))
        return response({ error: 'Unauthorized' }, 401);
      if (request.method === 'POST' && url.pathname === '/api/runs') {
        if (Number(request.headers.get('Content-Length') ?? 0) > 8192) return response({ error: 'Metadata too large' }, 413);
        const input = await request.json() as { size: number; partBytes: number; layout?: 'object' | 'segments'; partHashes?: string[] };
        if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_BYTES ||
            ![5, 8, 16].includes(input.partBytes / 1024 / 1024) ||
            input.layout && !['object', 'segments'].includes(input.layout)) return response({ error: 'Invalid size' }, 400);
        if (input.layout === 'segments' && (!Array.isArray(input.partHashes) ||
            input.partHashes.length !== Math.ceil(input.size / input.partBytes) ||
            input.partHashes.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))))
          return response({ error: 'Segment integrity metadata required' }, 400);
        const id = crypto.randomUUID();
        await env.RUNS.getByName(id).initialize(id, input.size, input.partBytes, input.layout, input.partHashes);
        return response({ id }, 201);
      }
      const match = /^\/api\/runs\/([0-9a-f-]{36})(?:\/(parts\/([1-9]\d*)|complete|file))?$/.exec(url.pathname);
      if (!match) return response({ error: 'Not found' }, 404);
      const run = env.RUNS.getByName(match[1]);
      if (request.method === 'GET' && !match[2]) return response(await run.snapshot());
      if (request.method === 'DELETE' && !match[2]) { await run.remove(); return new Response(null, { status: 204 }); }
      if (request.method === 'PUT' && match[3]) {
        const partNumber = Number(match[3]);
        const started = performance.now();
        const grant = await run.authorizePart(partNumber);
        const authorizedAt = performance.now();
        if (!request.body) return response({ error: 'Body required' }, 400);
        const bounded = new FixedLengthStream(grant.length);
        const controller = new AbortController();
        const pipe = request.body.pipeTo(bounded.writable, { signal: controller.signal });
        try {
          const upload = grant.uploadId
            ? env.FILES.resumeMultipartUpload(grant.key, grant.uploadId).uploadPart(partNumber, bounded.readable)
            : env.FILES.put(grant.key, bounded.readable, {
                onlyIf: { etagDoesNotMatch: '*' },
                sha256: grant.sha256,
                httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
              });
          const [result] = await Promise.all([upload, pipe]);
          const storedAt = performance.now();
          if (!result) return response({ error: 'Object already exists' }, 409);
          await run.recordPart({ partNumber, etag: result.etag });
          const timing = { authorize: authorizedAt - started, storage_and_body: storedAt - authorizedAt,
            receipt: performance.now() - storedAt };
          return response({ partNumber, timing }, 200, timing);
        } finally { controller.abort(); await pipe.catch(() => {}); }
      }
      if (request.method === 'POST' && match[2] === 'complete') {
        const started = performance.now();
        const result = await run.finalize();
        return response(result, 200, { finalize: performance.now() - started });
      }
      if (request.method === 'GET' && match[2] === 'file') {
        const started = performance.now();
        const key = await run.readableKey(url.searchParams.has('part') ? Number(url.searchParams.get('part')) : undefined);
        const authorizedAt = performance.now();
        const object = await env.FILES.get(key);
        if (!object) return response({ error: 'Original unavailable' }, 404);
        return new Response(object.body, { headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size),
          'Cache-Control': 'no-store', 'ETag': object.httpEtag, 'X-Content-Type-Options': 'nosniff',
          'Server-Timing': 'read_authorize;dur=' + (authorizedAt - started).toFixed(2) +
            ', object_headers;dur=' + (performance.now() - authorizedAt).toFixed(2),
        } });
      }
      return response({ error: 'Method not allowed' }, 405);
    } catch {
      return response({ error: 'Benchmark operation failed' }, 409);
    }
  },
} satisfies ExportedHandler<Env>;
