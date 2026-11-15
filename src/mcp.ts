/**
 * git-forge — the MCP endpoint (/mcp): JSON-RPC 2.0 over plain JSON
 * (Streamable HTTP transport).
 *
 * Speaks the modern era (server/discover, revision 2026-07-28) and the
 * legacy handshake (initialize + notifications/initialized). Tools act on
 * the same store as REST, so a repository or issue created over MCP reads
 * back over /api/v3 as the same object with the same id.
 */

import type { Issue, Store } from './store.ts';
import { isRecord } from './util.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpAnswer {
  status: number;
  json: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function result(id: string | number | null, value: unknown): McpAnswer {
  return { status: 200, json: { jsonrpc: '2.0', id, result: value } };
}

function error(id: string | number | null, code: number, message: string, status = 200): McpAnswer {
  return { status, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function repoView(store: Store, owner: string, name: string): Record<string, unknown> | null {
  const repo = store.resolveRepo(owner, name);
  if (repo === null) return null;
  const login = repo.owner ?? store.viewerLogin ?? owner;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueView(store: Store, repoName: string, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name })),
    user: { login: issue.user },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw { code: -32602, message: `unknown tool "${name}"` };
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  const owner = String(args.owner ?? store.viewerLogin ?? 'viewer');
  const repoName = String(args.repo ?? args.name ?? '');

  if (name === 'create_repo') {
    const repo = store.createRepo(String(args.name ?? ''), typeof args.description === 'string' ? args.description : '', args.private === true);
    if (repo === null) return toolError(`repository "${String(args.name ?? '')}" already exists`);
    return toolResult(repoView(store, owner, repo.name));
  }

  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) return toolError(`repository "${owner}/${repoName}" not found`);

  if (name === 'get_repo') return toolResult(repoView(store, owner, repoName));

  if (name === 'create_issue') {
    const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return toolResult(issueView(store, repoName, issue));
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
    return toolResult(issues.map((issue) => issueView(store, repoName, issue)));
  }

  if (name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return toolError(`head branch "${head}" does not exist`);
    if (baseSha === undefined) return toolError(`base branch "${base}" does not exist`);
    const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
    return toolResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      created_at: pull.createdAt,
    });
  }

  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return toolError(`pull request #${number} not found`);
    if (pull.merged || pull.state === 'closed') return toolError(`pull request #${number} is already merged or closed`);
    if (store.isConflicted(repo, pull)) return toolError(`pull request #${number} is not mergeable`);
    const sha = store.mergePull(repo, pull);
    return toolResult({ number: pull.number, merged: true, sha, state: pull.state });
  }

  return toolError(`tool "${name}" is not implemented`);
}

function handleOne(store: Store, request: JsonRpcRequest): McpAnswer | null {
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';

  // Notifications (no id) get no JSON-RPC answer.
  if (request.id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;
    return null;
  }

  if (method === 'server/discover') {
    return result(id, {
      supportedVersions: [MODERN_REVISION, ...LEGACY_REVISIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        'io.modelcontextprotocol/protocolVersion': MODERN_REVISION,
      },
    });
  }

  if (method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = [MODERN_REVISION, ...LEGACY_REVISIONS].includes(offered) ? offered : LEGACY_REVISIONS[0]!;
    return result(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') return result(id, {});

  if (method === 'tools/list') {
    return result(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      return result(id, callTool(store, toolName, args));
    } catch (err) {
      if (isRecord(err) && typeof err.code === 'number') {
        return error(id, err.code as number, String(err.message ?? 'tool call failed'));
      }
      return error(id, -32603, err instanceof Error ? err.message : String(err));
    }
  }

  return error(id, -32601, `method not found: ${method}`);
}

/**
 * Handle a POST /mcp body. `raw` is the request text; a body that is not
 * JSON answers HTTP 400 with JSON-RPC -32700. Returns null for a pure
 * notification (the server answers 202 with an empty body).
 */
export function handleMcp(store: Store, raw: string): McpAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const answer = handleOne(store, entry as JsonRpcRequest);
      if (answer !== null) answers.push(answer.json);
    }
    return { status: 200, json: answers };
  }
  if (!isRecord(parsed)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  return handleOne(store, parsed as JsonRpcRequest);
}
