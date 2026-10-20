import type { Page } from 'playwright';
import { transferInit, transferEval } from './transferHarness';

/** Test-only, worker-local timestamps: no binary payloads copied to the test
 * runner, and no production perf flag, endpoints or telemetry are enabled. */
export async function installTrace(page: Page): Promise<void> {
  await transferInit(page, `if(typeof document==='undefined'){
    const trace=window.__wireTrace={ranges:{},events:[]},Native=WebSocket;
    const now=()=>performance.timeOrigin+performance.now();
    const record=(data,sent)=>{try{
      if(typeof data==='string'){
        const message=JSON.parse(data);
        if(message.type==='range.request'){
          const range=trace.ranges[message.requestId] ||= {};
          range[sent?'requested':'sourceReceived']=now();
        }else if(/^(file.offer|file.announced|range.error|error|cache.progress|join.accepted|join.resumed)$/.test(message.type)&&trace.events.length<100)
          trace.events.push({type:message.type,sent,at:now(),code:message.code,bytes:message.type==='cache.progress'?message.bytes:undefined});
      }else if(data instanceof ArrayBuffer){
        const bytes=new Uint8Array(data),length=new DataView(data).getUint16(0);
        const header=JSON.parse(new TextDecoder().decode(bytes.subarray(2,length+2)));
        const range=trace.ranges[header.requestId] ||= {};range[sent?'sourceSent':'received']=now();
      }
    }catch{}};
    window.WebSocket=class extends Native{
      constructor(...args){super(...args);this.addEventListener('message',event=>record(event.data,false));
        this.addEventListener('close',event=>trace.events.push({type:'socket.close',at:now(),code:event.code}));}
      send(data){record(data,true);return super.send(data);}
    };
  }`);
}
type Trace = { ranges: Record<string, Record<string, number>>; events: Array<{ type: string; at: number; sent?: boolean; code?: unknown; bytes?: number }> };
export async function readTrace(host: Page, phone: Page, beganEpoch: number) {
  const [receiver, sender] = await Promise.all([host, phone].map(page => transferEval<Trace>(page, 'window.__wireTrace')));
  const ids = new Set([...Object.keys(receiver.ranges), ...Object.keys(sender.ranges)]);
  const ranges = [...ids].map(id => ({ ...receiver.ranges[id], ...sender.ranges[id] }));
  const completed = ranges.filter(range => range.received !== undefined);
  const last = completed.length ? Math.max(...completed.map(range => range.received)) : undefined;
  return {
    requestCount: ranges.length, unfinished: ranges.length - completed.length,
    lastByteMs: last === undefined ? null : Math.round(last - beganEpoch),
    events: [...receiver.events.map(event => ({ ...event, side: 'host' })), ...sender.events.map(event => ({ ...event, side: 'source' }))]
      .sort((a, b) => a.at - b.at).map(({ at, ...event }) => ({ ...event, ms: Math.round(at - beganEpoch) })),
    slowest: completed.map(range => ({ totalMs: Math.round(range.received - range.requested),
      sourceMs: Math.round(range.sourceSent - range.sourceReceived), downlinkMs: Math.round(range.received - range.sourceSent) }))
      .sort((a, b) => b.totalMs - a.totalMs).slice(0, 3),
  };
}
