/**
 * git-forge — the REST v3 surface (/api/v3): repositories, issues, pull
 * requests, contents, labels, branches, commits and the Git Data refs API.
 *
 * Every reply is JSON (never HTML) and carries X-GitHub-Request-Id; errors
 * carry a string `message`. Unknown routes are JSON 404s.
 */

import { parseCommit, parseTree } from './objects.ts';
import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import { base64Decode, base64Encode, globalId, isRecord, ZERO_OID } from './util.ts';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestAnswer {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const noContent = (): RestAnswer => ({ status: 204, json: null });

function userJson(store: Store, login: string): Record<string, unknown> {
  return {
    login,
    id: login === store.viewerLogin ? 1 : 2,
    node_id: globalId('User', login === store.viewerLogin ? 1 : 2),
    avatar_url: '',
    type: 'User',
    site_admin: false,
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userJson(store, owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: userJson(store, issue.user),
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/events`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${owner}:${ref}`,
    ref,
    sha,
    user: userJson(store, owner),
    repo: repoJson(store, repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: !store.isConflicted(repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: userJson(store, pull.user),
    head: refJson(pull.headRef, pull.headSha),
    base: refJson(pull.baseRef, pull.baseSha),
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(store, comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
  path: string,
): { page: T[]; link: string | null } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(Math.max(Math.trunc(perPageRaw), 1), 100) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(Math.trunc(pageRaw), 1) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (pageNumber: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(pageNumber));
    params.set('per_page', String(perPage));
    return `${baseUrl}${path}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  return { page: [...slice], link: links.length ? links.join(', ') : null };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

function requireRepo(store: Store, owner: string, name: string): Repo {
  const repo = store.resolveRepo(owner, name);
  if (repo === null) throw new ApiError(404, 'Not Found');
  return repo;
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date().toISOString() };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function contentsFileJson(
  store: Store,
  repo: Repo,
  path: string,
  blobOid: string,
  data: Buffer,
): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: base64Encode(data),
    sha: blobOid,
    url: `/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${owner}/${repo.name}/git/blobs/${blobOid}`,
    download_url: `https://raw.githubusercontent.com/${owner}/${repo.name}/${repo.defaultBranch}/${path}`,
    _links: {
      git: `/api/v3/repos/${owner}/${repo.name}/git/blobs/${blobOid}`,
      self: `/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
      html: `https://github.com/${owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    },
  };
}

function contentsDirJson(store: Store, repo: Repo, path: string, entries: ReturnType<typeof parseTree>): unknown[] {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  return entries.map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const isDir = entry.mode === '40000';
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      url: `/api/v3/repos/${owner}/${repo.name}/contents/${childPath}`,
      html_url: `https://github.com/${owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${childPath}`,
      git_url: `/api/v3/repos/${owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${owner}/${repo.name}/${repo.defaultBranch}/${childPath}`,
      _links: {
        git: `/api/v3/repos/${owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        self: `/api/v3/repos/${owner}/${repo.name}/contents/${childPath}`,
        html: `https://github.com/${owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${childPath}`,
      },
    };
  });
}

/**
 * Dispatch a REST request. `path` is the URL path after `/api/v3` (leading
 * slash, already decoded except that contents paths keep their slashes).
 */
export function handleRest(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestAnswer {
  const segments = path.split('/').filter((segment) => segment !== '');
  const bodyRecord = isRecord(body) ? body : {};

  // GET /api/v3/ — root.
  if (segments.length === 0) {
    if (method !== 'GET') throw new ApiError(404, 'Not Found');
    return {
      status: 200,
      json: {
        current_user_url: `${baseUrl}/api/v3/user`,
        repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
        user_url: `${baseUrl}/api/v3/users/{user}`,
      },
    };
  }

  // GET /api/v3/meta
  if (segments[0] === 'meta') {
    if (method !== 'GET' || segments.length !== 1) throw new ApiError(404, 'Not Found');
    return { status: 200, json: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }

  // GET /api/v3/user and /api/v3/user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') throw new ApiError(404, 'Not Found');
      return { status: 200, json: userJson(store, store.viewerLogin ?? 'viewer') };
    }
    if (segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.listRepos().filter((repo) => store.viewerLogin === null || repo.owner === store.viewerLogin);
        const { page, link } = paginate(repos.map((repo) => repoJson(store, repo)), query, baseUrl, `/api/v3${path}`);
        return { status: 200, json: page, headers: linkHeaders(link) };
      }
      if (method === 'POST') {
        const name = typeof bodyRecord.name === 'string' ? bodyRecord.name.trim() : '';
        if (name === '') throw new ApiError(422, 'name is required');
        const description = typeof bodyRecord.description === 'string' ? bodyRecord.description : '';
        const isPrivate = bodyRecord.private === true;
        const repo = store.createRepo(name, description, isPrivate);
        if (repo === null) throw new ApiError(422, 'name already exists on this account');
        return { status: 201, json: repoJson(store, repo) };
      }
      throw new ApiError(404, 'Not Found');
    }
    throw new ApiError(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments[0] === 'repos') {
    if (segments.length < 3) throw new ApiError(404, 'Not Found');
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const rest = segments.slice(3);
    const repo = requireRepo(store, owner, repoName);

    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, json: repoJson(store, repo) };
      if (method === 'PATCH') {
        if (typeof bodyRecord.description === 'string') repo.description = bodyRecord.description;
        if (typeof bodyRecord.default_branch === 'string' && bodyRecord.default_branch !== '') {
          repo.defaultBranch = bodyRecord.default_branch;
        }
        return { status: 200, json: repoJson(store, repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo.name);
        return noContent();
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      if (rest.length === 1) {
        if (method !== 'GET') throw new ApiError(404, 'Not Found');
        return {
          status: 200,
          json: branches.map((branch) => ({
            name: branch,
            commit: { sha: repo.refs.get(`refs/heads/${branch}`), url: `/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
            protected: false,
          })),
        };
      }
      if (rest.length === 2) {
        if (method !== 'GET') throw new ApiError(404, 'Not Found');
        const branch = rest[1]!;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) throw new ApiError(404, 'Branch not found');
        return {
          status: 200,
          json: {
            name: branch,
            commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
            protected: false,
          },
        };
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'commits') {
      if (method !== 'GET') throw new ApiError(404, 'Not Found');
      const branch = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) throw new ApiError(404, 'Branch not found');
      const perPage = Math.min(Math.max(Number(query.get('per_page') ?? '30') || 30, 1), 100);
      const walk = store.commitWalk(repo, tip, perPage);
      return {
        status: 200,
        json: walk.map((sha) => {
          const commit = parseCommit(repo.objects.get(sha)!.data);
          return {
            sha,
            commit: {
              message: commit.message,
              author: parseIdentity(commit.author),
              committer: parseIdentity(commit.committer),
              tree: { sha: commit.tree },
            },
            parents: commit.parents.map((parent) => ({ sha: parent })),
          };
        }),
      };
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length > 2) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) throw new ApiError(404, 'Not Found');
        return {
          status: 200,
          json: {
            ref,
            node_id: globalId('Ref', repo.id),
            url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}`,
            object: { type: 'commit', sha, url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
          },
        };
      }
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof bodyRecord.ref === 'string' ? bodyRecord.ref : '';
        const sha = typeof bodyRecord.sha === 'string' ? bodyRecord.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
          throw new ApiError(422, 'Invalid ref or sha');
        }
        if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
        if (repo.objects.get(sha) === undefined) throw new ApiError(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return {
          status: 201,
          json: {
            ref,
            node_id: globalId('Ref', repo.id),
            url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}`,
            object: { type: 'commit', sha, url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
          },
        };
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      const branch = typeof bodyRecord.branch === 'string' ? bodyRecord.branch : query.get('ref') ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) throw new ApiError(404, 'Branch not found');
        const commitObject = repo.objects.get(tip);
        if (commitObject?.type !== 'commit') throw new ApiError(404, 'Not Found');
        const treeOid = parseCommit(commitObject.data).tree;
        if (contentPath === '') {
          return { status: 200, json: contentsDirJson(store, repo, '', parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0))) };
        }
        const found = store.readPath(repo, treeOid, contentPath);
        if (found === null) throw new ApiError(404, 'Not Found');
        if (found.kind === 'file') return { status: 200, json: contentsFileJson(store, repo, contentPath, found.oid, found.data) };
        return { status: 200, json: contentsDirJson(store, repo, contentPath, found.entries) };
      }
      if (method === 'PUT') {
        const message = typeof bodyRecord.message === 'string' ? bodyRecord.message : `Update ${contentPath}`;
        const content = typeof bodyRecord.content === 'string' ? base64Decode(bodyRecord.content) : Buffer.alloc(0);
        // Resolve the branch: create it from the default tip when it does not exist yet.
        if (repo.refs.get(`refs/heads/${branch}`) === undefined) {
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultTip !== undefined) repo.refs.set(`refs/heads/${branch}`, defaultTip);
        }
        const tip = repo.refs.get(`refs/heads/${branch}`);
        let existed: { kind: 'file'; oid: string; data: Buffer } | null = null;
        if (tip !== undefined) {
          const commitObject = repo.objects.get(tip);
          if (commitObject?.type === 'commit') {
            const found = store.readPath(repo, parseCommit(commitObject.data).tree, contentPath);
            if (found !== null && found.kind === 'file') existed = found;
          }
        }
        if (existed !== null) {
          if (typeof bodyRecord.sha !== 'string' || bodyRecord.sha === '') {
            throw new ApiError(422, 'sha was not supplied');
          }
          if (bodyRecord.sha !== existed.oid) throw new ApiError(409, 'sha does not match the current file');
        }
        const { commitSha, blobSha } = store.writePath(repo, branch, contentPath, content, message);
        return {
          status: existed === null ? 201 : 200,
          json: {
            content: contentsFileJson(store, repo, contentPath, blobSha ?? ZERO_OID, content),
            commit: { sha: commitSha, message },
          },
        };
      }
      if (method === 'DELETE') {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) throw new ApiError(404, 'Branch not found');
        const commitObject = repo.objects.get(tip);
        if (commitObject?.type !== 'commit') throw new ApiError(404, 'Not Found');
        const found = store.readPath(repo, parseCommit(commitObject.data).tree, contentPath);
        if (found === null || found.kind !== 'file') throw new ApiError(404, 'Not Found');
        if (typeof bodyRecord.sha === 'string' && bodyRecord.sha !== '' && bodyRecord.sha !== found.oid) {
          throw new ApiError(409, 'sha does not match the current file');
        }
        const message = typeof bodyRecord.message === 'string' ? bodyRecord.message : `Delete ${contentPath}`;
        const { commitSha } = store.writePath(repo, branch, contentPath, null, message);
        return { status: 200, json: { commit: { sha: commitSha, message } } };
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (method === 'GET') {
        return { status: 200, json: [...repo.labels.values()].map(labelJson) };
      }
      if (method === 'POST') {
        const name = typeof bodyRecord.name === 'string' ? bodyRecord.name.trim() : '';
        if (name === '') throw new ApiError(422, 'name is required');
        if (repo.labels.has(name)) throw new ApiError(422, 'Label already exists');
        const label: Label = {
          id: store.allocateId(),
          name,
          color: typeof bodyRecord.color === 'string' ? bodyRecord.color : 'ededed',
          description: typeof bodyRecord.description === 'string' ? bodyRecord.description : '',
        };
        repo.labels.set(name, label);
        return { status: 201, json: labelJson(label) };
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page, link } = paginate(issues.map((issue) => issueJson(store, repo, issue)), query, baseUrl, `/api/v3${path}`);
          return { status: 200, json: page, headers: linkHeaders(link) };
        }
        if (method === 'POST') {
          const title = typeof bodyRecord.title === 'string' ? bodyRecord.title.trim() : '';
          if (title === '') throw new ApiError(422, 'title is required');
          const bodyText = typeof bodyRecord.body === 'string' ? bodyRecord.body : '';
          const labelNames = Array.isArray(bodyRecord.labels) ? bodyRecord.labels : [];
          const labels: Label[] = [];
          for (const name of labelNames) {
            if (typeof name !== 'string') continue;
            const label = repo.labels.get(name);
            if (label === undefined) throw new ApiError(422, `Label "${name}" does not exist`);
            labels.push(label);
          }
          const issue = store.createIssue(repo, title, bodyText, labels);
          return { status: 201, json: issueJson(store, repo, issue) };
        }
        throw new ApiError(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) throw new ApiError(404, 'Not Found');
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) throw new ApiError(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return { status: 200, json: issueJson(store, repo, issue) };
        if (method === 'PATCH') {
          if (typeof bodyRecord.title === 'string') issue.title = bodyRecord.title;
          if (typeof bodyRecord.body === 'string') issue.body = bodyRecord.body;
          if (bodyRecord.state === 'open' || bodyRecord.state === 'closed') {
            issue.state = bodyRecord.state;
            issue.closedAt = bodyRecord.state === 'closed' ? new Date().toISOString() : null;
          }
          issue.updatedAt = new Date().toISOString();
          return { status: 200, json: issueJson(store, repo, issue) };
        }
        throw new ApiError(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          return { status: 200, json: issue.comments.map((comment) => commentJson(store, repo, issue, comment)) };
        }
        if (method === 'POST') {
          const bodyText = typeof bodyRecord.body === 'string' ? bodyRecord.body.trim() : '';
          if (bodyText === '') throw new ApiError(422, 'body is required');
          const comment = store.createComment(issue, bodyText);
          return { status: 201, json: commentJson(store, repo, issue, comment) };
        }
        throw new ApiError(404, 'Not Found');
      }
      throw new ApiError(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.seq - a.seq);
          const { page, link } = paginate(pulls.map((pull) => pullJson(store, repo, pull)), query, baseUrl, `/api/v3${path}`);
          return { status: 200, json: page, headers: linkHeaders(link) };
        }
        if (method === 'POST') {
          const title = typeof bodyRecord.title === 'string' ? bodyRecord.title.trim() : '';
          const head = typeof bodyRecord.head === 'string' ? bodyRecord.head : '';
          const base = typeof bodyRecord.base === 'string' ? bodyRecord.base : '';
          if (title === '' || head === '' || base === '') throw new ApiError(422, 'title, head and base are required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined) throw new ApiError(422, `head branch "${head}" does not exist`);
          if (baseSha === undefined) throw new ApiError(422, `base branch "${base}" does not exist`);
          const bodyText = typeof bodyRecord.body === 'string' ? bodyRecord.body : '';
          const pull = store.createPull(repo, title, bodyText, head, base, headSha, baseSha);
          return { status: 201, json: pullJson(store, repo, pull) };
        }
        throw new ApiError(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) throw new ApiError(404, 'Not Found');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) throw new ApiError(404, 'Not Found');
      if (rest.length === 2) {
        if (method !== 'GET') throw new ApiError(404, 'Not Found');
        return { status: 200, json: pullJson(store, repo, pull) };
      }
      if (rest[2] === 'files') {
        if (method !== 'GET') throw new ApiError(404, 'Not Found');
        const files = store.pullFiles(repo, pull).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: `https://github.com/${owner}/${repoName}/blob/${pull.headSha}/${file.filename}`,
          raw_url: `https://raw.githubusercontent.com/${owner}/${repoName}/${pull.headSha}/${file.filename}`,
          contents_url: `/api/v3/repos/${owner}/${repoName}/contents/${file.filename}?ref=${pull.headRef}`,
        }));
        return { status: 200, json: files };
      }
      if (rest[2] === 'merge') {
        if (method !== 'PUT') throw new ApiError(404, 'Not Found');
        if (pull.merged || pull.state === 'closed') throw new ApiError(405, 'Pull Request is already merged or closed');
        if (store.isConflicted(repo, pull)) throw new ApiError(405, 'Pull Request is not mergeable');
        const sha = store.mergePull(repo, pull);
        return { status: 200, json: { sha, merged: true, message: 'Pull Request successfully merged' } };
      }
      throw new ApiError(404, 'Not Found');
    }

    throw new ApiError(404, 'Not Found');
  }

  throw new ApiError(404, 'Not Found');
}
