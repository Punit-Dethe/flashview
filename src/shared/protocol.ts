// Initial safety cap; file format is unrestricted.
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** Maximum number of file manifests a sender can create in one room. */
export const MAX_STUDENT_FILES = 10;
// Backwards-compatible name for older PDF-only integrations.
export const MAX_PDF_BYTES = MAX_FILE_BYTES;
export const MAX_RANGE_BYTES = 256 * 1024;
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
export const RANGE_TIMEOUT_MS = 20_000;

export interface FileManifest {
  fileId: string;
  name: string;
  size: number;
  ownerId: string;
  ownerName: string;
  status: 'pending' | 'approved' | 'rejected' | 'offline';
  /** Explicit owner stop: reconnecting must never resume this file ID. */
  revoked?: boolean;
  /** Cached bytes last acknowledged by the classroom computer (not sent bytes). */
  cachedBytes?: number;
  /** Metadata transition version; absent in rooms written by older relays. */
  revision?: number;
}

export interface StudentInfo {
  id: string;
  name: string;
  approved: boolean;
}

export interface RangeHeader {
  type: 'range.data';
  requestId: string;
  fileId: string;
  begin: number;
}

/** Compatibility alias while the PDF-only presenter keeps its original types. */
export type PdfManifest = FileManifest;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Two-byte big-endian JSON header length, followed by UTF-8 header + arbitrary binary file bytes. */
export function encodeRangePacket(header: RangeHeader, data: ArrayBuffer | Uint8Array): ArrayBuffer {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.length > 2048) throw new Error('Range header too large');
  const packet = new Uint8Array(2 + headerBytes.length + bytes.byteLength);
  new DataView(packet.buffer).setUint16(0, headerBytes.length);
  packet.set(headerBytes, 2);
  packet.set(bytes, 2 + headerBytes.length);
  return packet.buffer;
}

export function decodeRangePacket(packet: ArrayBuffer): { header: RangeHeader; bytes: Uint8Array } {
  if (packet.byteLength < 3) throw new Error('Truncated binary packet');
  const headerSize = new DataView(packet).getUint16(0);
  if (headerSize === 0 || headerSize > 2048 || 2 + headerSize > packet.byteLength) {
    throw new Error('Invalid packet header');
  }
  const header = JSON.parse(decoder.decode(new Uint8Array(packet, 2, headerSize))) as RangeHeader;
  if (header.type !== 'range.data' || !Number.isSafeInteger(header.begin) || header.begin < 0 ||
      typeof header.requestId !== 'string' || typeof header.fileId !== 'string') {
    throw new Error('Invalid range header');
  }
  return { header, bytes: new Uint8Array(packet, 2 + headerSize) };
}
