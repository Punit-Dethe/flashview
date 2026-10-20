import type { Page, Worker } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

const installed = new WeakMap<Page, string[]>();
const ready = new WeakMap<Worker, Promise<void>>();
/** Inject faults into the actual transfer owner, without a production debug API. */
export async function transferInit(page: Page, script: string | { content: string } | Function, arg?: unknown): Promise<void> {
  let scripts = installed.get(page);
  if (!scripts) {
    scripts = []; installed.set(page, scripts);
    // Hold only initial commands until faults are installed. Fetching/replacing
    // module responses through Playwright routing can break worker WebSockets.
    await page.addInitScript(`{
      const Native = Worker;
      globalThis.__transferTestWorkers = [];
      globalThis.Worker = class extends Native {
        constructor(url, options) {
          const address = new URL(String(url), location.href);
          const transfer = /\\/relayWorker-/.test(address.pathname);
          if (transfer) address.searchParams.set('__testOwner', String(globalThis.__transferTestWorkers.length));
          super(address, options);
          if (transfer) { this.__held = []; globalThis.__transferTestWorkers.push(this); this.__url = address.href; }
        }
        postMessage(...args) { if (this.__held) this.__held.push(args); else super.postMessage(...args); }
        __release() { const held = this.__held; this.__held = null; for (const args of held) super.postMessage(...args); }
      };
    }`);
    page.on('worker', worker => {
      if (!/\/relayWorker-/.test(worker.url())) return;
      const setup = (async () => {
        const source = installed.get(page)!.map(script => script.replaceAll('location.search', JSON.stringify(new URL(page.url()).search))).join('\n');
        await worker.evaluate('globalThis.window=globalThis;\n' + source);
        await page.evaluate(url => {
          const workers = (globalThis as typeof globalThis & { __transferTestWorkers: Array<{ __url: string; __release(): void }> }).__transferTestWorkers;
          workers.find(worker => worker.__url === url)?.__release();
        }, worker.url());
      })();
      ready.set(worker, setup);
      setup.catch(() => {}); // The awaiting fault test reports setup errors.
    });
  }
  const text = typeof script === 'function' ? '(' + script.toString() + ')(' + JSON.stringify(arg) + ');'
    : typeof script === 'string' ? script : script.content;
  scripts.push(text);
  await page.addInitScript({ content: text });
}
export async function transferWorker(page: Page): Promise<Worker> {
  const existing = page.workers().find(worker => /\/relayWorker-/.test(worker.url()));
  const worker = existing ?? await page.waitForEvent('worker', { predicate: worker => /\/relayWorker-/.test(worker.url()) });
  await ready.get(worker);
  await worker.evaluate('globalThis.window=globalThis');
  return worker;
}
export async function transferEval<T = unknown, A = void>(page: Page, expression: string | ((arg: A) => T | Promise<T>), arg?: A): Promise<T> {
  return (await transferWorker(page)).evaluate(expression as string, arg) as Promise<T>;
}
export async function transferWait<A = void>(page: Page, expression: string | ((arg: A) => unknown), arg?: A, timeout = 15000): Promise<void> {
  const began = Date.now();
  while (Date.now() - began < timeout) {
    if (await transferEval(page, expression, arg)) return;
    await delay(50);
  }
  throw Error('Transfer worker condition timed out');
}
