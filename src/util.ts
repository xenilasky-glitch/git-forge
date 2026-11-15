/**
 * git-forge — a GitHub-compatible git forge in one Node process.
 *
 * Small shared helpers: SHA-1, pkt-line framing (the git smart-HTTP wire
 * format), base64 and JSON plumbing. No third-party dependencies.
 */

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** One pkt-line: a 4-hex-digit length (itself included) plus the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line too long: ${length}`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem = string | Buffer | 'flush' | 'delim';

/** Encode a list of pkt-lines / flush / delim markers into one buffer. */
export function pktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed frame so callers
 * can answer 400 instead of crashing the server.
 */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const out: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('bad pkt-line length or truncated packet');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return out;
}

/** Split a pkt-line stream into its data payloads, stopping at the first flush. */
export function pktDataBeforeFlush(buf: Buffer): { packets: Buffer[]; rest: Buffer } {
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      offset += 4;
      return { packets, rest: Buffer.from(buf.subarray(offset)) };
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('bad pkt-line length or truncated packet');
    packets.push(Buffer.from(buf.subarray(offset + 4, offset + length)));
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

export function base64Encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

export function base64Decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** An opaque, stable global id (never the plain database id or number). */
export function globalId(kind: string, numericId: number): string {
  return base64Encode(`${kind}:${numericId}`);
}

/** Parse an opaque global id back into kind + numeric id, or null. */
export function parseGlobalId(id: string): { kind: string; numericId: number } | null {
  try {
    const text = base64Decode(id).toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!match) return null;
    return { kind: match[1]!, numericId: Number(match[2]) };
  } catch {
    return null;
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** A short random request id for the X-GitHub-Request-Id header. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
