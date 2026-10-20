import type { PdfManifest } from '../shared/protocol';
import type { CacheProgress } from './pdf/roomCache';
import type { ServerMessage, SocketStatus } from './socket';
import type { PerfRecord } from './perf';

export type WorkerCommand =
  | { type: 'connect'; identity: Record<string, unknown> }
  | { type: 'send'; message: Record<string, unknown> }
  | { type: 'sources'; files: Array<{ fileId: string; file: File }> }
  | { type: 'wake'; reason?: 'focus' | 'online' }
  | { type: 'pause'; frozen: boolean }
  | { type: 'close' }
  | { type: 'room'; roomId: string }
  | { type: 'stop' }
  | { type: 'retry-storage' }
  | { type: 'rpc'; id: number; method: 'progress' | 'preview' | 'save-preview' | 'read' | 'clear';
      roomId: string; file?: PdfManifest; fileId?: string; dataUrl?: string; begin?: number; end?: number }
  | { type: 'cancel'; id: number }
  | { type: 'ack' };
export type WorkerEvent =
  | { type: 'message'; message: ServerMessage }
  | { type: 'status'; status: SocketStatus }
  | { type: 'progress'; progress: CacheProgress }
  | { type: 'warning'; message: string }
  | { type: 'blocked' | 'recovered' | 'stalled'; fileId: string }
  | { type: 'perf'; record: PerfRecord };
export type WorkerReply =
  | { type: 'events'; events: WorkerEvent[] }
  | { type: 'result'; id: number; value?: unknown; error?: string };
export type WorkerEnvelope = { session: number; command: WorkerCommand };
