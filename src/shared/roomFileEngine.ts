import { admitFile } from './roomAdmission';
import type { FileManifest } from './protocol';

type Owner = { id: string; name: string; approved: boolean };
export type FileTransition = {
  file: FileManifest; changed: boolean;
  kind: 'created' | 'updated' | 'replayed' | 'revoked' | 'progress' | 'lifecycle';
};
export type FileEffect = { to: 'host' | 'actor' | 'owner'; ownerId?: string; message: Record<string, unknown> };

/** Synchronous metadata rules only. No socket, storage, renderer or byte-packet work. */
export class RoomFileEngine {
  private records: Map<string, FileManifest>;
  private mutationVersion = 0;
  private savedVersion = 0;
  get needsPersistence(): boolean { return this.mutationVersion !== this.savedVersion; }
  get files(): ReadonlyMap<string, FileManifest> { return this.records; }
  clear(): void { this.records.clear(); this.mutationVersion++; this.onMutation(); }
  checkpoint(): { files: FileManifest[]; confirm: () => void } {
    const version = this.mutationVersion;
    return { files: [...this.records.values()].map(file => ({ ...file })),
      confirm: () => { this.savedVersion = Math.max(this.savedVersion, version); } };
  }
  constructor(stored: FileManifest[] = [], private readonly onMutation: () => void = () => {}) {
    this.records = new Map(stored.map(file => [file.fileId, { ...file }]));
  }
  private change(file: FileManifest, update: Partial<FileManifest>): FileManifest {
    const revision = Number.isSafeInteger(file.revision) && file.revision! >= 0 ? file.revision! : 0;
    const next = { ...file, ...update, revision: revision + 1 };
    this.records.set(next.fileId, next);
    this.mutationVersion++;
    this.onMutation();
    return next;
  }
  offer(owner: Owner, command: { fileId?: unknown; name?: unknown; size?: unknown }):
    FileTransition | { kind: 'rejected'; code: string; message: string } {
    const result = admitFile(this.records, owner, command);
    if (result.kind === 'rejected') return result;
    const changed = result.kind !== 'replayed';
    const file = changed ? this.change(result.file, {}) : result.file;
    return { kind: result.kind, file, changed };
  }
  revoke(ownerId: string, fileId: unknown): FileTransition | null {
    const file = typeof fileId === 'string' ? this.files.get(fileId) : undefined;
    if (!file || file.ownerId !== ownerId) return null;
    const changed = file.status !== 'offline' || file.revoked !== true;
    return { kind: 'revoked', changed, file: changed ? this.change(file, { status: 'offline', revoked: true }) : file };
  }
  cacheProgress(fileId: unknown, bytes: unknown, snapshot: unknown): FileTransition | null {
    const file = typeof fileId === 'string' ? this.files.get(fileId) : undefined;
    if (!file || !Number.isSafeInteger(bytes) ||
        (bytes !== file.size && !(snapshot === true && bytes === 0))) return null;
    const changed = file.cachedBytes !== bytes;
    return { kind: 'progress', changed, file: changed ? this.change(file, { cachedBytes: Number(bytes) }) : file };
  }
  ownerStatus(ownerId: string, action: 'disconnect' | 'approve' | 'resume', approved = true): FileTransition[] {
    const changes: FileTransition[] = [];
    for (const file of this.files.values()) {
      if (file.ownerId !== ownerId) continue;
      let status: FileManifest['status'] | undefined;
      if (action === 'disconnect' && file.status === 'approved') status = 'offline';
      if (file.revoked !== true) {
        if (action === 'approve' && file.status === 'pending') status = 'approved';
        if (action === 'resume' && file.status === 'offline') status = approved ? 'approved' : 'pending';
      }
      if (status && status !== file.status)
        changes.push({ kind: 'lifecycle', changed: true, file: this.change(file, { status }) });
    }
    return changes;
  }
  /** Evaluate AFTER persistence: an older async completion cannot publish stale state. */
  effects(transition: FileTransition): FileEffect[] {
    const file = this.files.get(transition.file.fileId);
    if (!file) return [];
    if (file !== transition.file) {
      // An offer still gets a truthful reconciliation after Stop/disconnect.
      return ['created', 'updated', 'replayed'].includes(transition.kind)
        ? [{ to: 'actor', message: { type: 'file.state', file: { ...file } } }] : [];
    }
    const effects: FileEffect[] = [];
    const metadata = { ...file };
    if (transition.kind === 'progress') {
      const bytes = file.cachedBytes!;
      if (transition.changed) effects.push({ to: 'owner', ownerId: file.ownerId,
        message: { type: 'cache.progress', fileId: file.fileId, bytes, size: file.size,
          complete: bytes === file.size, fileRevision: file.revision } });
      if (bytes === file.size) effects.push({ to: 'actor', message: {
        type: 'cache.progress.receipt', fileId: file.fileId, bytes, fileRevision: file.revision,
      } });
      return effects;
    }
    if (transition.kind !== 'replayed') effects.push({ to: 'host', message: {
      type: transition.kind === 'created' ? 'file.announced' : 'file.updated', file: metadata,
    } });
    if (transition.kind === 'created') effects.push({ to: 'actor', message: { type: 'file.approved', fileId: file.fileId } });
    if (['created', 'updated', 'replayed'].includes(transition.kind))
      effects.push({ to: 'actor', message: { type: 'file.state', file: metadata } });
    return effects;
  }
}

/** The adapter must preserve storage write order. A failed write never confirms a checkpoint. */
export async function persistRoomFiles(engine: RoomFileEngine,
  write: (files: FileManifest[]) => Promise<unknown>, force = false): Promise<void> {
  if (!engine.needsPersistence && !force) return;
  const checkpoint = engine.checkpoint();
  await write(checkpoint.files);
  checkpoint.confirm();
}
