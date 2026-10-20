const metadataTypes = new Set(['room.state', 'room.closed', 'join.pending', 'join.accepted', 'join.resumed', 'join.rejected',
  'student.pending', 'student.updated', 'student.left', 'file.announced', 'file.updated', 'file.state', 'file.approved',
  'file.pending', 'file.rejected', 'file.manifest', 'cache.progress', 'cache.progress.receipt', 'host.online', 'host.offline']);
export function versionedMetadata(type: unknown): boolean { return typeof type === 'string' && metadataTypes.has(type); }
