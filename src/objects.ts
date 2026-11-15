/**
 * git-forge — git object model: raw object hashing, commit/tree/tag parsing
 * and building, packfile reading/writing (with ofs-delta and ref-delta
 * resolution), and reachability closure for fetch.
 *
 * Objects are stored byte-exactly: a pushed commit round-trips unchanged.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex, isObjectId, ZERO_OID } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** The canonical git object id: sha1("<type> <len>\0<data>"). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

const AGENT_IDENTITY = 'git-forge <git-forge@localhost>';

/** Build a commit object. Timestamps are real time; parents default to none. */
export function buildCommit(tree: string, parents: readonly string[], message: string, when?: Date): Buffer {
  const stamp = Math.floor((when ?? new Date()).getTime() / 1000);
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${AGENT_IDENTITY} ${stamp} +0000`);
  lines.push(`committer ${AGENT_IDENTITY} ${stamp} +0000`);
  lines.push('');
  lines.push(message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Apply a git delta to a base object, per the delta format (varints + ops). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[offset++]!;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++]!;
      if (op & 0x02) copyOffset |= delta[offset++]! << 8;
      if (op & 0x04) copyOffset |= delta[offset++]! << 16;
      if (op & 0x08) copyOffset |= delta[offset++]! << 24;
      if (op & 0x10) copySize = delta[offset++]!;
      if (op & 0x20) copySize |= delta[offset++]! << 8;
      if (op & 0x40) copySize |= delta[offset++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('truncated delta insert');
      chunks.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  if (produced !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks);
}

/** Read a packfile, resolving ofs-delta and ref-delta against the pack itself and a fallback resolver. */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): { objects: Map<string, GitObject>; deltaCount: number } {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the trailing checksum is the sha1 of everything before it.
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expect = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer !== expect) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    type: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const offsets: number[] = [];
  let offset = 12;
  const readSizeAndType = (): { type: number; size: number } => {
    const first = pack[offset++]!;
    const type = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { type, size };
  };
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    offsets.push(start);
    const { type, size } = readSizeAndType();
    if (type === 6) {
      // ofs-delta: a negative offset to the base, encoded byte by byte.
      let byte = pack[offset++]!;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const data = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset);
      void size;
      raw.push({ type, data, baseOffset: start - baseOffset });
    } else if (type === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const data = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset);
      void size;
      raw.push({ type, data, baseOid });
    } else {
      const data = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset);
      void size;
      raw.push({ type, data });
    }
  }

  const typeName = (code: number): ObjectType => {
    if (code === 1) return 'commit';
    if (code === 2) return 'tree';
    if (code === 3) return 'blob';
    if (code === 4) return 'tag';
    throw new Error(`unknown pack object type ${code}`);
  };

  const objects = new Map<string, GitObject>();
  const resolved: Array<GitObject | undefined> = new Array(raw.length).fill(undefined);
  let deltaCount = 0;
  const oidOf = (object: GitObject): string => hashObject(object.type, object.data);
  const findResolvedByOid = (oid: string): GitObject | undefined => {
    for (const candidate of resolved) {
      if (candidate !== undefined && oidOf(candidate) === oid) return candidate;
    }
    return undefined;
  };
  const resolve = (index: number, seen: Set<number>): GitObject | undefined => {
    const done = resolved[index];
    if (done !== undefined) return done;
    if (seen.has(index)) throw new Error('delta cycle in pack');
    seen.add(index);
    const entry = raw[index]!;
    if (entry.type === 6 || entry.type === 7) {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseIndex = offsets.indexOf(entry.baseOffset);
        if (baseIndex < 0) throw new Error('ofs-delta base offset not found in pack');
        base = resolve(baseIndex, seen);
        if (base === undefined) return undefined;
      } else if (entry.baseOid !== undefined) {
        base = findResolvedByOid(entry.baseOid) ?? resolveBase?.(entry.baseOid);
        if (base === undefined) return undefined;
      } else {
        throw new Error('delta without a base');
      }
      deltaCount += 1;
      const data = applyDelta(base.data, entry.data);
      const object: GitObject = { type: base.type, data };
      resolved[index] = object;
      objects.set(oidOf(object), object);
      return object;
    }
    const object: GitObject = { type: typeName(entry.type), data: entry.data };
    resolved[index] = object;
    objects.set(oidOf(object), object);
    return object;
  };

  // First pass: non-delta entries (so ref-delta bases inside the pack resolve).
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i]!.type !== 6 && raw[i]!.type !== 7) resolve(i, new Set());
  }
  // Fixpoint passes for deltas (a delta's base may itself be a delta that
  // appears later in the pack; real packs order bases first, this covers
  // anything else).
  for (let pass = 0; pass < raw.length + 1; pass += 1) {
    let progressed = false;
    for (let i = 0; i < raw.length; i += 1) {
      if (resolved[i] === undefined && resolve(i, new Set()) !== undefined) progressed = true;
    }
    if (resolved.every((entry) => entry !== undefined)) break;
    if (!progressed) {
      throw new Error('pack delta base not found');
    }
  }
  return { objects, deltaCount };
}

/**
 * Length of the zlib stream starting at `offset` (found by exponential
 * probing then binary search; inflateSync ignores trailing bytes and throws
 * on a truncated stream, so the smallest succeeding end is the true end).
 */
function compressedLength(pack: Buffer, offset: number): number {
  const tryEnd = (end: number): boolean => {
    try {
      inflateSync(pack.subarray(offset, end));
      return true;
    } catch {
      return false;
    }
  };
  // Exponential probe: most objects are small.
  let step = 16;
  let end = offset + step;
  while (end < pack.length && !tryEnd(end)) {
    step *= 2;
    end = offset + step;
  }
  if (end >= pack.length) {
    if (!tryEnd(pack.length)) throw new Error('truncated zlib stream in pack');
    end = pack.length;
  }
  let low = offset + 1;
  let high = end;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (tryEnd(mid)) high = mid;
    else low = mid + 1;
  }
  return low - offset;
}

/** Write an undeltified pack (type + zlib(raw)) for the given objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(objects.length, 4);
  parts.push(header);
  for (const object of objects) {
    const typeCode = object.type === 'commit' ? 1 : object.type === 'tree' ? 2 : object.type === 'blob' ? 3 : 4;
    const size = object.data.length;
    const head: number[] = [];
    let remaining = size;
    head.push((typeCode << 4) | (remaining & 0x0f));
    remaining >>= 4;
    while (remaining > 0) {
      head[head.length - 1] |= 0x80;
      head.push(remaining & 0x7f);
      remaining >>= 7;
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

export interface ClosureResult {
  /** Objects to send, by oid (commits, trees, blobs, tags). */
  send: Map<string, GitObject>;
  /** Commits at the shallow boundary (parents withheld). */
  shallow: string[];
  /** Request-shallow commits whose parents are now included. */
  unshallow: string[];
  /** Acks for haves that are ancestors of (or equal to) a want. */
  acks: string[];
}

/**
 * Compute the fetch closure: objects reachable from `wants`, minus anything
 * the client already holds, optionally limited to `depth` commit generations
 * (depth 1 = the wanted commits only, measured from the want).
 *
 * What the client "holds" is everything reachable from its `haves` — but a
 * shallow boundary stops the walk: a shallow clone holds the boundary commit
 * and its tree, not the boundary's parents. The `requestShallow` boundaries
 * are exactly that cut, so the held set is reachable-from-haves minus
 * below-the-boundaries.
 */
export function computeClosure(
  getObject: (oid: string) => GitObject | undefined,
  wants: readonly string[],
  haves: readonly string[],
  depth?: number,
  requestShallow?: readonly string[],
): ClosureResult {
  const send = new Map<string, GitObject>();
  const haveOids = new Set(haves.filter(isObjectId));
  const shallowSet = new Set((requestShallow ?? []).filter(isObjectId));
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const acks: string[] = [];

  // The held set: everything reachable from the haves, stopping at shallow
  // boundaries (their trees are held, their parents are not).
  const heldSet = new Set<string>();
  const addHeldTree = (treeOid: string): void => {
    if (heldSet.has(treeOid)) return;
    const tree = getObject(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    heldSet.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (heldSet.has(entry.oid)) continue;
      if (entry.mode === '40000') addHeldTree(entry.oid);
      else heldSet.add(entry.oid);
    }
  };
  const heldQueue = [...haveOids];
  while (heldQueue.length) {
    const oid = heldQueue.pop()!;
    if (heldSet.has(oid)) continue;
    heldSet.add(oid);
    const object = getObject(oid);
    if (object?.type === 'commit') {
      addHeldTree(parseCommit(object.data).tree);
      if (!shallowSet.has(oid)) {
        for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
      }
    } else if (object?.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    } else if (object?.type === 'tree') {
      addHeldTree(oid);
    }
  }

  const addTreeClosure = (treeOid: string): void => {
    if (send.has(treeOid) || heldSet.has(treeOid)) return;
    const tree = getObject(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    send.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (heldSet.has(entry.oid) || send.has(entry.oid)) continue;
      const child = getObject(entry.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') addTreeClosure(entry.oid);
      else send.set(entry.oid, child);
    }
  };

  // Which haves are ancestors of (or equal to) a want — for ACK lines.
  const reachableFrom = (start: string, stopAt: Set<string>): Set<string> => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid) || stopAt.has(oid)) continue;
      seen.add(oid);
      const object = getObject(oid);
      if (object?.type === 'commit') {
        const commit = parseCommit(object.data);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object?.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return seen;
  };
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    const reach = reachableFrom(want, new Set());
    for (const have of haveOids) {
      if (reach.has(have) && !acks.includes(have)) acks.push(have);
    }
  }

  // Commit traversal with depth limit and held cutoff. A want that is
  // already held is still walked through when a depth limit is in effect:
  // the depth window is measured from the want, so the commits below a held
  // shallow boundary are reachable only by passing through it.
  const visited = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    if (!isObjectId(want)) continue;
    queue.push({ oid: want, depth: 0 });
  }
  const boundaryParents = new Map<string, string[]>(); // sent commit -> withheld parents
  while (queue.length) {
    const { oid, depth: atDepth } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = getObject(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!heldSet.has(oid)) send.set(oid, object);
      const target = parseTag(object.data).object;
      if (isObjectId(target) && !visited.has(target)) {
        queue.push({ oid: target, depth: atDepth });
      }
      continue;
    }
    if (object.type !== 'commit') {
      // A tree or blob wanted directly.
      if (object.type === 'tree') addTreeClosure(oid);
      else if (!heldSet.has(oid)) send.set(oid, object);
      continue;
    }
    const commit = parseCommit(object.data);
    const isHeld = heldSet.has(oid);
    if (!isHeld) {
      send.set(oid, object);
      addTreeClosure(commit.tree);
    }
    const withheld: string[] = [];
    for (const parent of commit.parents) {
      // A held commit's parents are already held — unless a depth limit is
      // in effect, in which case the walk continues through it.
      if (isHeld && depth === undefined) continue;
      if (depth !== undefined && atDepth + 1 >= depth) {
        if (!isHeld) withheld.push(parent);
        continue;
      }
      if (!visited.has(parent)) queue.push({ oid: parent, depth: atDepth + 1 });
    }
    if (withheld.length) boundaryParents.set(oid, withheld);
  }

  // Shallow boundary: sent commits whose parents were withheld by the depth
  // limit (parents not sent and not held by the client).
  for (const [commitOid, parents] of boundaryParents) {
    const stillMissing = parents.filter((parent) => !send.has(parent) && !heldSet.has(parent));
    if (stillMissing.length) shallow.push(commitOid);
  }
  // Previously-shallow commits: unshallow when their parents are now sent
  // (or already held by the client); otherwise they stay shallow (a
  // partially-deepened boundary is still a boundary — its history is
  // incomplete).
  for (const old of requestShallow ?? []) {
    if (!isObjectId(old)) continue;
    const object = getObject(old);
    if (object?.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    // "Sent" includes already held by the client: a boundary whose parents
    // the client holds is no longer shallow.
    const allSent = parents.every((parent) => send.has(parent) || heldSet.has(parent));
    if (allSent && !unshallow.includes(old)) unshallow.push(old);
    else if (!shallow.includes(old)) shallow.push(old);
  }

  void ZERO_OID;
  return { send, shallow, unshallow, acks };
}
