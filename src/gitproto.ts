/**
 * git-forge — git smart HTTP: info/refs advertisements (v0 and v2),
 * upload-pack (ls-refs, fetch) and receive-pack (push).
 *
 * Wire notes the implementation follows:
 * - v0 advertisement opens with "# service=git-<svc>" + flush; the first
 *   ref line carries capabilities after a NUL byte. An empty repo advertises
 *   "<zero> capabilities^{}" with the same capabilities.
 * - v2 advertisement opens with "version 2" and capability lines.
 * - v2 fetch answers sections (acknowledgments, shallow-info, packfile),
 *   separated by delim packets, terminated by flush. A packfile section is
 *   only opened when there are objects to send, and its bytes ride
 *   sideband-64k band 1.
 * - receive-pack answers a report-status stream ("unpack ok", "ok <ref>" /
 *   "ng <ref> <reason>"), sideband-framed when negotiated.
 */

import {
  computeClosure,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
} from './objects.ts';
import type { Repo, Store } from './store.ts';
import {
  pktLines,
  pktLine,
  PKT_FLUSH,
  PKT_DELIM,
  decodePktLines,
  pktDataBeforeFlush,
  ZERO_OID,
  isoNow,
} from './util.ts';

const AGENT = 'git-forge/1.0';
const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main object-format=sha1`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (object?.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** GET /{owner}/{repo}.git/info/refs?service=git-upload-pack (or receive-pack). */
export function infoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  wantsV2: boolean,
): GitResponse {
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.alloc(0) };
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';

  if (service === 'git-upload-pack' && wantsV2) {
    const body = pktLines([
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow\n',
      'object-format=sha1\n',
      'flush',
    ]);
    return { status: 200, contentType, body };
  }

  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([name, oid], index) => {
      if (index === 0) {
        // The first ref line carries the capabilities. HEAD goes first so
        // the symref is visible on it.
        const main = repo.refs.get('refs/heads/main');
        if (main !== undefined) {
          parts.push(pktLine(`${main} HEAD\0${caps}\n`));
        } else {
          parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
          return;
        }
      }
      parts.push(pktLine(`${oid} ${name}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 (ls-refs / fetch) or v0 (fetch). */
export function uploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  isV2: boolean,
): GitResponse {
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.alloc(0) };
  if (isV2) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: uploadPackV2(repo, body) };
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: uploadPackV0(repo, body) };
}

function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let index = 0;
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
    } else {
      args.push(line.replace(/\n$/, ''));
    }
    index += 1;
  }
  void index;
  if (command === 'ls-refs') return lsRefsV2(repo, args);
  if (command === 'fetch') return fetchV2(repo, args);
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

function lsRefsV2(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const main = repo.refs.get('refs/heads/main');
  // HEAD is a ref named "HEAD": include it when the client asked for
  // symrefs and it matches the requested prefixes (git asks for the
  // literal prefix "HEAD" when it wants to learn the default branch).
  if (symrefs && keep('HEAD')) {
    if (main !== undefined) lines.push(`${main} HEAD symref-target:refs/heads/main`);
    else if (unborn) lines.push('unborn HEAD symref-target:refs/heads/main');
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    }
    lines.push(line);
  }
  return pktLines([...lines.map((line) => `${line}\n`), 'flush']);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  ofsDelta: boolean;
  done: boolean;
}

function parseFetchArgs(args: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, ofsDelta: false, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim().split(' ')[0]!);
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = Number(arg.slice(7).trim());
    else if (arg === 'ofs-delta') out.ofsDelta = true;
    else if (arg === 'done') out.done = true;
  }
  return out;
}

function sidebandPackets(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunk = 32768;
  for (let offset = 0; offset < data.length; offset += chunk) {
    const slice = data.subarray(offset, Math.min(offset + chunk, data.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return parts;
}

function fetchV2(repo: Repo, args: readonly string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const closure = computeClosure(
    (oid) => repo.objects.get(oid),
    parsed.wants,
    parsed.haves,
    parsed.depth,
    parsed.shallow,
  );
  // Sections, in order: acknowledgments (only when the client sent "have"
  // lines — without haves the client expects the packfile section straight
  // away), shallow-info, packfile. Sections are joined by delim packets;
  // the stream never opens with one.
  //
  // Negotiation rounds (real git sends "have" lines first and "done" only
  // in a follow-up request):
  // - common base found ("ACK"): the acks section carries a "ready" line
  //   and the packfile follows IN THIS SAME RESPONSE — git dies with
  //   "expected packfile to be sent after 'ready'" if it does not. (When
  //   there is nothing to send, the response ends after the acks section
  //   and git accepts that: every want was already acked.)
  // - no common base ("NAK"): answer with the acks section only and wait;
  //   the client follows with more "have" lines or "done".
  const sections: Buffer[][] = [];
  if (parsed.haves.length > 0) {
    const ack: Buffer[] = [pktLine('acknowledgments\n')];
    if (closure.acks.length) {
      for (const ackOid of closure.acks) ack.push(pktLine(`ACK ${ackOid}\n`));
      if (!parsed.done) ack.push(pktLine('ready\n'));
    } else {
      ack.push(pktLine('NAK\n'));
    }
    sections.push(ack);
    if (!parsed.done && closure.acks.length === 0) {
      return Buffer.concat([...ack, PKT_FLUSH]);
    }
  }
  if (closure.shallow.length || closure.unshallow.length) {
    const info: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of closure.shallow) info.push(pktLine(`shallow ${oid}\n`));
    for (const oid of closure.unshallow) info.push(pktLine(`unshallow ${oid}\n`));
    sections.push(info);
  }
  if (closure.send.size > 0) {
    const objects: GitObject[] = [...closure.send.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, object]) => object);
    const pack = writePack(objects);
    sections.push([pktLine('packfile\n'), ...sidebandPackets(pack)]);
  }
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    if (index > 0) parts.push(PKT_DELIM);
    parts.push(...section);
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const parsed = parseFetchArgs(args);
  const closure = computeClosure(
    (oid) => repo.objects.get(oid),
    parsed.wants,
    parsed.haves,
    parsed.depth,
    parsed.shallow,
  );
  const parts: Buffer[] = [];
  if (closure.acks.length) {
    for (const ack of closure.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  if (closure.send.size > 0) {
    const objects: GitObject[] = [...closure.send.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, object]) => object);
    parts.push(...sidebandPackets(writePack(objects)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack — validate and apply a push. */
export function receivePack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): GitResponse {
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.alloc(0) };
  const { packets, rest } = pktDataBeforeFlush(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  for (const raw of packets) {
    const text = raw.toString('utf8');
    const nul = text.indexOf('\0');
    let line = text;
    let caps = '';
    if (nul >= 0) {
      line = text.slice(0, nul);
      caps = text.slice(nul + 1);
    }
    if (caps.length) {
      const list = caps.trim().split(/\s+/);
      sideband = list.includes('side-band-64k');
      reportStatus = list.includes('report-status') || list.includes('report-status-v2');
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(line.trim());
    if (match === null) throw new Error(`bad receive-pack command line ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  void reportStatus;

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updates = commands.filter((command) => command.newOid !== ZERO_OID);
  if (commands.length === 0) throw new Error('receive-pack with no commands');
  if (updates.length > 0) {
    if (rest.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpack failed: pack missing';
    } else {
      try {
        const { objects } = readPack(rest, (oid) => repo.objects.get(oid));
        store.putObjects(repo, objects);
      } catch (error) {
        unpackOk = false;
        unpackDetail = `unpack failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'stale ref' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'stale ref' });
        continue;
      }
      if (command.newOid !== command.oldOid && !store.isAncestor(repo, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    if (repo.objects.get(command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (results.some((result) => result.ok)) {
    repo.pushedAt = isoNow();
    repo.updatedAt = isoNow();
  }

  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = pktLines([...reportLines, 'flush']);
  let responseBody: Buffer;
  if (sideband) {
    responseBody = Buffer.concat(sidebandPackets(report));
    responseBody = Buffer.concat([responseBody, PKT_FLUSH]);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}
