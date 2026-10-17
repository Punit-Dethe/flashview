export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_RANGE_BYTES = 256 * 1024;
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
export const RANGE_TIMEOUT_MS = 20_000;
export const STREAM_CREDITS = 8;
export const STREAM_IDLE_MS = 30_000;

export interface PdfManifest {
  fileId: string;
  name: string;
  size: number;
  ownerId: string;
  ownerName: string;
  status: 'pending' | 'approved' | 'rejected' | 'offline';
  /** Cached bytes last acknowledged by the classroom computer (not sent bytes). */
  cachedBytes?: number;
}

export interface StudentInfo {
  id: string;
  name: string;
  approved: boolean;
}

export interface RangeHeader {
  type: 'range.data' | 'stream.data';
  requestId: string;
  fileId: string;
  begin: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Two-byte big-endian JSON header length, followed by UTF-8 header + binary PDF bytes. */
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
  if ((header.type !== 'range.data' && header.type !== 'stream.data') ||
      !Number.isSafeInteger(header.begin) || header.begin < 0 ||
      typeof header.requestId !== 'string' || typeof header.fileId !== 'string') {
    throw new Error('Invalid range header');
  }
  return { header, bytes: new Uint8Array(packet, 2 + headerSize) };
}
