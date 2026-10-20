import { versionedMetadata } from '../shared/roomVersion';

/** Equal revisions can contain several effects of one transition. Legacy peers drain in place. */
export class RoomRevisionTracker {
  private generation: string | undefined;
  private latest = -1;
  private resyncPending = false;
  constructor(generation?: string) { this.generation = generation; }
  reset(generation?: string): void { this.generation = generation; this.latest = -1; this.resyncPending = false; }
  observe(message: { type: string; [key: string]: unknown }): { accept: boolean; scopeMatches: boolean; resync: boolean } {
    if (!versionedMetadata(message.type) || typeof message.roomGeneration !== 'string' ||
        !Number.isSafeInteger(message.roomRevision) || Number(message.roomRevision) < 0)
      return { accept: true, scopeMatches: true, resync: false };
    const scopeMatches = !this.generation || this.generation === message.roomGeneration;
    const snapshot = message.type === 'room.state' || message.type === 'file.manifest';
    if (scopeMatches && Number(message.roomRevision) >= this.latest) {
      this.generation = message.roomGeneration; this.latest = Number(message.roomRevision);
      if (snapshot) this.resyncPending = false;
      return { accept: true, scopeMatches: true, resync: false };
    }
    if (snapshot && scopeMatches) this.resyncPending = false;
    const resync = !this.resyncPending;
    this.resyncPending = true;
    return { accept: false, scopeMatches, resync };
  }
}
