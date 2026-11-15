/**
 * git-forge — the in-memory store: repositories, git objects, refs, issues,
 * pull requests, labels and comments. One process, no database.
 *
 * Ownership rule (the suite's wire contract): a repository belongs to the
 * login the token names. The entry cannot know that login in advance, so it
 * learns it from the first `{owner}` path segment it sees and adopts
 * repositories created before learning. After learning, any other owner in
 * a path is a foreign owner and answers 404, never 403.
 */

import {
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  buildTree,
  buildCommit,
  type GitObject,
  type TreeEntry,
} from './objects.ts';
import { globalId, isoNow, ZERO_OID } from './util.ts';

export interface UserRef {
  login: string;
  id: number;
  type: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null; // null until the viewer login is learned
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  seq: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

const VIEWER_ID = 1;

export class Store {
  viewerLogin: string | null = null;
  repos = new Map<string, Repo>();
  private nextId = 1;
  private nextSeq = 1;

  /** Allocate a fresh stable numeric id (repos, issues, pulls, labels, comments). */
  allocateId(): number {
    return this.nextId++;
  }

  viewerUser(): UserRef {
    return { login: this.viewerLogin ?? 'viewer', id: VIEWER_ID, type: 'User' };
  }

  /** Learn the viewer login from a path segment; returns the settled login. */
  learnViewer(owner: string): string {
    if (this.viewerLogin === null) this.viewerLogin = owner;
    return this.viewerLogin;
  }

  /**
   * Resolve a repository by owner + name, adopting placeholder-owned repos
   * once the viewer is learned. Returns null for a missing repo or a
   * foreign owner (the caller answers 404).
   */
  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) {
      if (this.viewerLogin !== null && owner !== this.viewerLogin) return null;
      repo.owner = owner;
      this.viewerLogin = owner;
    }
    if (repo.owner !== owner) return null;
    return repo;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const now = isoNow();
    const repo: Repo = {
      id: this.nextId++,
      name,
      owner: this.viewerLogin,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      seq: this.nextSeq++,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): void {
    this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // ------------------------------------------------------------ git objects

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(repo: Repo, objects: Map<string, GitObject>): void {
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  refTarget(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Is `descendant` reachable from `ancestor` (first-parent walk is not enough: full ancestry)? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      } else if (object?.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return false;
  }

  /** First-parent walk from `tip`, newest first. */
  commitWalk(repo: Repo, tip: string, limit: number): string[] {
    const out: string[] = [];
    let current: string | undefined = tip;
    const seen = new Set<string>();
    while (current !== undefined && out.length < limit && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (object?.type !== 'commit') break;
      out.push(current);
      current = parseCommit(object.data).parents[0];
    }
    return out;
  }

  /** The merge base of two commits: the newest commit reachable from both. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (fromA.has(oid)) continue;
      fromA.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueA.push(parent);
      }
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.pop()!;
      if (fromA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queueB.push(parent);
      }
    }
    return null;
  }

  // ------------------------------------------------------------ tree editing

  private treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    const object = repo.objects.get(treeOid);
    if (object?.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** Read a path under a tree: file blob, directory entries, or null. */
  readPath(
    repo: Repo,
    treeOid: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const parts = path.split('/').filter((part) => part !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = this.treeEntries(repo, current);
      const entry = entries.find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) return null;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          return { kind: 'dir', entries: this.treeEntries(repo, entry.oid) };
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return { kind: 'dir', entries: this.treeEntries(repo, current) };
  }

  /** Set (or delete) a path in a tree, writing new tree objects bottom-up. */
  private setPathInTree(
    repo: Repo,
    treeOid: string | null,
    parts: readonly string[],
    blobOid: string | null,
  ): string {
    const entries = treeOid === null ? [] : this.treeEntries(repo, treeOid);
    const [head, ...rest] = parts;
    if (head === undefined) return treeOid ?? this.putObject(repo, 'tree', buildTree([]));
    const index = entries.findIndex((entry) => entry.name === head);
    if (rest.length === 0) {
      // Leaf: replace, add, or remove the entry.
      if (blobOid === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '100644', name: head, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name: head, oid: blobOid });
      }
    } else {
      const childTree = index >= 0 && entries[index]!.mode === '40000' ? entries[index]!.oid : null;
      const next = this.setPathInTree(repo, childTree, rest, blobOid);
      const childEntries = this.treeEntries(repo, next);
      if (childEntries.length === 0 && blobOid === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '40000', name: head, oid: next };
      } else {
        entries.push({ mode: '40000', name: head, oid: next });
      }
    }
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  /** Create a commit on `branch` that sets `path` to `content` (or deletes it). */
  writePath(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    let baseTree: string | null = null;
    const parents: string[] = [];
    if (tip !== undefined) {
      const commitObject = repo.objects.get(tip);
      if (commitObject?.type === 'commit') {
        baseTree = parseCommit(commitObject.data).tree;
        parents.push(tip);
      }
    }
    let blobSha: string | null = null;
    if (content !== null) blobSha = this.putObject(repo, 'blob', content);
    const parts = path.split('/').filter((part) => part !== '');
    const nextTree = this.setPathInTree(repo, baseTree, parts, blobSha);
    const commitSha = this.putObject(repo, 'commit', buildCommit(nextTree, parents, message));
    repo.refs.set(ref, commitSha);
    repo.updatedAt = isoNow();
    return { commitSha, blobSha };
  }

  // ------------------------------------------------------------ issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = isoNow();
    const issue: Issue = {
      id: this.nextId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: this.viewerLogin ?? 'viewer',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
      seq: this.nextSeq++,
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(issue: Issue, body: string): Comment {
    const now = isoNow();
    const comment: Comment = {
      id: this.nextId++,
      body,
      user: this.viewerLogin ?? 'viewer',
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
  ): Pull {
    const now = isoNow();
    const pull: Pull = {
      id: this.nextId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      closedAt: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      user: this.viewerLogin ?? 'viewer',
      createdAt: now,
      updatedAt: now,
      seq: this.nextSeq++,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha. */
  mergePull(repo: Repo, pull: Pull): string {
    const headCommit = repo.objects.get(pull.headSha);
    if (headCommit?.type !== 'commit') throw new Error('pull head is not a commit');
    const headTree = parseCommit(headCommit.data).tree;
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseTip = repo.refs.get(baseRef);
    const parents = baseTip !== undefined ? [baseTip] : [];
    const message = `Merge pull request #${pull.number} from ${repo.owner ?? 'viewer'}/${pull.headRef}`;
    const commitSha = this.putObject(repo, 'commit', buildCommit(headTree, parents, message));
    repo.refs.set(baseRef, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = commitSha;
    const now = isoNow();
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    repo.updatedAt = now;
    return commitSha;
  }

  /** Files changed between the merge base and the head of a pull request. */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const base = this.mergeBase(repo, pull.headSha, pull.baseSha) ?? pull.baseSha;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pull.headSha);
    if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit') return [];
    const files: PullFile[] = [];
    this.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree, '', files);
    return files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  }

  /** Flatten a tree to path -> blob oid (files only, recursive). */
  private flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
    for (const entry of this.treeEntries(repo, treeOid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, entry.oid);
    }
  }

  /**
   * True when the head and the base both changed the same file differently
   * since the merge base — a three-way merge would conflict. Compared
   * against the base branch's CURRENT tip, so a pull request that was
   * clean when opened can become conflicted after another merge lands.
   */
  isConflicted(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.mergeBase(repo, pull.headSha, baseTip) ?? pull.baseSha;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pull.headSha);
    const tipCommit = repo.objects.get(baseTip);
    if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit' || tipCommit?.type !== 'commit') return false;
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    const tipFiles = new Map<string, string>();
    this.flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseFiles);
    this.flattenTree(repo, parseCommit(headCommit.data).tree, '', headFiles);
    this.flattenTree(repo, parseCommit(tipCommit.data).tree, '', tipFiles);
    const paths = new Set([...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const before = baseFiles.get(path);
      const head = headFiles.get(path);
      const tip = tipFiles.get(path);
      const headChanged = head !== before;
      const baseChanged = tip !== before;
      if (headChanged && baseChanged && head !== tip) return true;
    }
    return false;
  }

  private diffTrees(repo: Repo, baseTree: string, headTree: string, prefix: string, out: PullFile[]): void {
    const baseEntries = new Map(this.treeEntries(repo, baseTree).map((entry) => [entry.name, entry]));
    const headEntries = new Map(this.treeEntries(repo, headTree).map((entry) => [entry.name, entry]));
    const names = new Set([...baseEntries.keys(), ...headEntries.keys()]);
    for (const name of [...names].sort()) {
      const base = baseEntries.get(name);
      const head = headEntries.get(name);
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (base === undefined && head !== undefined) {
        if (head.mode === '40000') {
          this.diffTrees(repo, ZERO_OID, head.oid, path, out);
        } else {
          const data = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
          const lines = countLines(data);
          out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
        }
      } else if (base !== undefined && head === undefined) {
        if (base.mode === '40000') {
          this.diffTrees(repo, base.oid, ZERO_OID, path, out);
        } else {
          const data = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
          const lines = countLines(data);
          out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
        }
      } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
        if (base.mode === '40000' && head.mode === '40000') {
          this.diffTrees(repo, base.oid, head.oid, path, out);
        } else if (base.mode !== '40000' && head.mode !== '40000') {
          const oldData = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
          const newData = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
          const { additions, deletions } = lineDiff(oldData, newData);
          out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
        } else {
          const oldData = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
          const newData = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
          out.push({
            filename: path,
            status: 'modified',
            additions: countLines(newData),
            deletions: countLines(oldData),
            changes: countLines(newData) + countLines(oldData),
          });
        }
      }
    }
  }
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Changed lines by common prefix/suffix trimming (good enough for the suite's small files). */
function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}
