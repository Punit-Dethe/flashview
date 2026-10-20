import { RoomFileEngine, type FileTransition } from './roomFileEngine';
import { admitSender } from './roomAdmission';
import { consumeWindow, JOIN_LIMIT, JOIN_WINDOW_MS, JOIN_RATE_MESSAGE, type RateWindow } from './connectionGuards';
import type { FileManifest, StudentInfo } from './protocol';

export type ResumeSession = StudentInfo & { token: string };
export type Participant = ResumeSession & { connection: object };
export type RoomMetadata = { files: FileManifest[]; sessions: ResumeSession[]; joinWindow: RateWindow | null; roomRevision: number };
type Rejected = { kind: 'rejected'; code: string; message: string; retryable: boolean; retryAfterMs?: number };
export type Joined = { kind: 'joined'; resumed: boolean; participant: Participant; displaced?: object; changes: FileTransition[] };

/** Shared metadata authority; connections are opaque identities, never byte transports. */
export class RoomEngine {
  readonly fileState: RoomFileEngine;
  private records = new Map<string, ResumeSession>();
  private active = new Map<string, Participant>();
  private host: object | null = null;
  private ended = false;
  private joinWindow: RateWindow | null;
  private version: number;
  private saved: number;
  private saving: Promise<void> = Promise.resolve();
  get revision(): number { return this.version; }
  get needsPersistence(): boolean { return this.version !== this.saved; }
  get sessions(): ReadonlyMap<string, ResumeSession> { return this.records; }
  constructor(stored: Partial<RoomMetadata> = {}) {
    this.version = Number.isSafeInteger(stored.roomRevision) && stored.roomRevision! >= 0 ? stored.roomRevision! : 0;
    this.saved = this.version;
    this.joinWindow = stored.joinWindow ? { ...stored.joinWindow } : null;
    for (const session of stored.sessions ?? []) this.records.set(session.token, { ...session });
    this.fileState = new RoomFileEngine(stored.files, () => { this.version++; });
  }
  restoreHost(connection: object): void { this.host = connection; }
  restoreParticipant(connection: object, id: string): Participant | undefined {
    const session = [...this.records.values()].find(record => record.id === id);
    if (!session) return;
    const participant = { ...session, connection };
    this.active.set(id, participant); return participant;
  }
  connectHost(connection: object): object | null {
    const previous = this.host; this.host = connection;
    if (previous !== connection) this.version++;
    return previous;
  }
  disconnectHost(connection: object): boolean {
    if (this.host !== connection) return false;
    this.host = null; this.version++; return true;
  }
  isHost(connection: object): boolean { return this.host === connection; }
  participant(id: string): Participant | undefined { return this.active.get(id); }
  isCurrent(participant: Participant): boolean { return this.active.get(participant.id) === participant; }
  students(): StudentInfo[] { return [...this.active.values()].map(({ id, name, approved }) => ({ id, name, approved })); }
  join(input: { connection: object; id: string; name: unknown; resumeToken: unknown; newToken: string;
    autoApprove: boolean; hostOnline: boolean; now: number }): Joined | Rejected {
    if (this.ended) return { kind: 'rejected', code: 'ROOM_CLOSED', message: 'Room expired', retryable: false };
    const previous = typeof input.resumeToken === 'string' ? this.records.get(input.resumeToken) : undefined;
    const admission = admitSender(this.active.size, this.records.size, !!previous, !!previous && this.active.has(previous.id));
    if (admission.kind === 'rejected') return admission;
    if (!previous && !input.hostOnline) return {
      kind: 'rejected', code: 'HOST_OFFLINE', message: 'The host is offline', retryable: false,
    };
    let session = previous;
    if (!session) {
      const rate = consumeWindow(this.joinWindow, JOIN_LIMIT, JOIN_WINDOW_MS, input.now);
      if (!rate.allowed) return { kind: 'rejected', code: 'JOIN_RATE_LIMIT', message: JOIN_RATE_MESSAGE,
        retryable: true, retryAfterMs: rate.retryAfterMs };
      this.joinWindow = rate.window;
      session = { id: input.id, approved: input.autoApprove,
        name: typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) || 'Student' : 'Student',
        token: typeof input.resumeToken === 'string' && /^[a-f0-9]{64}$/.test(input.resumeToken) ? input.resumeToken : input.newToken };
      this.records.set(session.token, session);
    }
    const displaced = this.active.get(session.id)?.connection;
    const participant = { ...session, connection: input.connection };
    this.active.set(session.id, participant); this.version++;
    const changes = previous ? this.fileState.ownerStatus(session.id, 'resume', session.approved) : [];
    return { kind: 'joined', participant, displaced, resumed: !!previous, changes };
  }
  approve(id: string): { participant: Participant; changes: FileTransition[] } | null {
    const previous = this.active.get(id);
    if (!previous) return null;
    const session = this.records.get(previous.token);
    if (!session) return null;
    let participant = previous;
    if (!previous.approved) {
      const approved = { ...session, approved: true };
      this.records.set(approved.token, approved);
      participant = { ...approved, connection: previous.connection };
      this.active.set(id, participant); this.version++;
    }
    return { participant, changes: this.fileState.ownerStatus(id, 'approve') };
  }
  reject(id: string): { participant?: Participant; changes: FileTransition[] } | null {
    const session = [...this.records.values()].find(record => record.id === id);
    if (!session) return null;
    const participant = this.active.get(id);
    this.records.delete(session.token); this.active.delete(id); this.version++;
    return { participant, changes: this.fileState.ownerStatus(id, 'disconnect') };
  }
  disconnect(id: string, connection: object): { changes: FileTransition[] } | null {
    if (this.active.get(id)?.connection !== connection) return null;
    this.active.delete(id); this.version++;
    return { changes: this.fileState.ownerStatus(id, 'disconnect') };
  }
  clear(): void { this.ended = true; this.host = null; this.active.clear(); this.records.clear(); this.joinWindow = null; this.fileState.clear(); }
  /** Serialize and coalesce saves; each caller waits only for its required version. */
  async persist(write: (snapshot: RoomMetadata) => Promise<unknown>): Promise<void> {
    const target = this.version;
    if (this.ended || this.saved >= target) return;
    const task = this.saving.catch(() => {}).then(async () => {
      if (this.ended || this.saved >= target) return;
      const checkpoint = this.fileState.checkpoint(), version = this.version;
      const snapshot: RoomMetadata = { files: checkpoint.files, sessions: [...this.records.values()].map(record => ({ ...record })),
        joinWindow: this.joinWindow ? { ...this.joinWindow } : null, roomRevision: version };
      await write(snapshot);
      checkpoint.confirm(); this.saved = version;
    });
    this.saving = task; await task;
  }
}
