import relay from '../../src/cloudflare/index';
import { signCapability, verifyCapability } from '../capability';
export { ClassroomRoom } from '../../src/cloudflare/index';

type RelayEnv = Parameters<typeof relay.fetch>[1];
type Env = RelayEnv & { BENCH_TOKEN: string };

/** Protected isolated deployment of the unchanged relay for a fair live comparison. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, experiment: 'relay' });
    if (!env.BENCH_TOKEN || env.BENCH_TOKEN.length < 32) return new Response('Benchmark disabled', { status: 503 });
    if (url.pathname === '/__benchmark/invite') {
      if (request.method === 'POST' && request.headers.get('Authorization') === 'Bearer ' + env.BENCH_TOKEN) {
        const ticket = await signCapability(env.BENCH_TOKEN, {
          id: crypto.randomUUID(), role: 'relay', expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        });
        return Response.json({ url: url.origin + '/__benchmark/invite?ticket=' + ticket },
          { headers: { 'Cache-Control': 'no-store' } });
      }
      const ticket = url.searchParams.get('ticket') ?? '';
      const claims = await verifyCapability(env.BENCH_TOKEN, ticket);
      if (request.method !== 'GET' || claims?.role !== 'relay') return new Response('Invite expired', { status: 401 });
      return new Response(null, { status: 302, headers: {
        Location: '/', 'Set-Cookie': 'fv_pilot=' + ticket + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7200',
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      } });
    }
    if (url.pathname === '/__benchmark/session') {
      if (request.headers.get('Authorization') !== 'Bearer ' + env.BENCH_TOKEN)
        return new Response('Unauthorized', { status: 401 });
      return new Response(null, { status: 204, headers: {
        'Set-Cookie': 'fv_bench=' + env.BENCH_TOKEN + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600',
        'Cache-Control': 'no-store',
      } });
    }
    const cookies = request.headers.get('Cookie')?.split(';').map(part => part.trim()) ?? [];
    const admin = cookies.includes('fv_bench=' + env.BENCH_TOKEN);
    const ticket = cookies.find(part => part.startsWith('fv_pilot='))?.slice('fv_pilot='.length) ?? '';
    if (!admin && (await verifyCapability(env.BENCH_TOKEN, ticket))?.role !== 'relay')
      return new Response('Unauthorized', { status: 401 });
    return relay.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
