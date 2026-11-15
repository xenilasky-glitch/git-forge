/**
 * git-forge — a small GraphQL executor for the exact documents the suite
 * sends (viewer, repository, node, __type, issues, pull requests and the
 * five mutations), plus batched requests (a JSON array body).
 *
 * It parses the query text (one operation per document), validates field
 * names against the schema, and resolves against the same store as REST.
 * Unknown fields answer HTTP 200 with an `errors` array naming the field;
 * an unknown repository answers `data.repository = null` with no errors.
 */

import type { Issue, Pull, Repo, Store } from './store.ts';
import { base64Decode, base64Encode, globalId, isRecord, parseGlobalId } from './util.ts';

// ------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | undefined;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeName: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | undefined;
  selections: SelectionNode[];
}

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} in GraphQL document, got ${token.value}`);
    }
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseValue();
    }
  }

  parseDocument(): Operation {
    const first = this.peek();
    let type: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') name = this.next().value;
    }
    // Variable definitions: ( $x: Type = default, ... ) — skipped in detail.
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      let depth = 0;
      do {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        else if (token.kind === 'punct' && token.value === ')') depth -= 1;
      } while (depth > 0);
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return out;
      }
      if (token.kind === 'spread') {
        this.next();
        const on = this.next();
        if (on.kind !== 'name' || on.value !== 'on') throw new Error('expected "on" in inline fragment');
        const typeName = this.next();
        if (typeName.kind !== 'name') throw new Error('expected a type name in inline fragment');
        this.skipDirectives();
        out.push({ kind: 'fragment', typeName: typeName.value, selections: this.parseSelectionSet() });
        continue;
      }
      out.push(this.parseField());
    }
  }

  private parseField(): FieldNode {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected a field name');
    let name = first.value;
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      const real = this.next();
      if (real.kind !== 'name') throw new Error('expected a field name after alias');
      name = real.value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      for (;;) {
        const token = this.peek();
        if (token?.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args[key.value] = this.parseValue();
      }
    }
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a variable name');
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        fields[key.value] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ------------------------------------------------------------------- schema

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'avatarUrl'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'closedAt', 'updatedAt', 'url', 'author', 'comments'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'body', 'createdAt', 'closedAt'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestFileEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'comment', 'clientMutationId'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PULL_REQUEST'] },
};

// ------------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type AnyObject = { __typename: string; [key: string]: unknown };

function resolveValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, ctx);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: Ctx): unknown {
  const node = field.args[name];
  return node === undefined ? undefined : resolveValue(node, ctx);
}

function issueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(store: Store, repo: Repo, issue: Issue): AnyObject {
  return {
    __typename: 'Issue',
    id: globalId('Issue', issue.id),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    state: issueState(issue.state),
    body: issue.body,
    createdAt: issue.createdAt,
    closedAt: issue.closedAt,
    updatedAt: issue.updatedAt,
    url: `https://github.com/${repo.owner ?? 'viewer'}/${repo.name}/issues/${issue.number}`,
    _issue: issue,
    _repo: repo,
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): AnyObject {
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    state: pullState(pull),
    merged: pull.merged,
    mergeable: store.isConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    body: pull.body,
    createdAt: pull.createdAt,
    closedAt: pull.closedAt,
    _pull: pull,
    _repo: repo,
  };
}

function repoObject(store: Store, repo: Repo): AnyObject {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    description: repo.description,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

function encodeCursor(number: number): string {
  return base64Encode(`cursor:${number}`);
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = base64Decode(cursor).toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function pageIssues(
  issues: Issue[],
  first: number | undefined,
  after: string | undefined,
  direction: 'asc' | 'desc',
): Page<Issue> {
  const ordered = direction === 'asc' ? [...issues].sort((a, b) => a.seq - b.seq) : [...issues].sort((a, b) => b.seq - a.seq);
  let start = 0;
  if (after !== undefined && after !== null) {
    const cursorNumber = decodeCursor(String(after));
    if (cursorNumber !== null) {
      const index = ordered.findIndex((issue) => issue.number === cursorNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const size = first ?? 30;
  const nodes = ordered.slice(start, start + size);
  const hasNextPage = start + size < ordered.length;
  return {
    nodes,
    hasNextPage,
    endCursor: nodes.length ? encodeCursor(nodes[nodes.length - 1]!.number) : null,
    startCursor: nodes.length ? encodeCursor(nodes[0]!.number) : null,
  };
}

function typeInfo(name: string): AnyObject | null {
  if (name === 'Issue') {
    return { __typename: '__Type', name: 'Issue', kind: 'OBJECT', fields: (SCHEMA.Issue!.fields ?? []).map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'PullRequest') {
    return { __typename: '__Type', name: 'PullRequest', kind: 'OBJECT', fields: (SCHEMA.PullRequest!.fields ?? []).map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'Repository') {
    return { __typename: '__Type', name: 'Repository', kind: 'OBJECT', fields: (SCHEMA.Repository!.fields ?? []).map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
  }
  if (name === 'SearchType') {
    return { __typename: '__Type', name: 'SearchType', kind: 'ENUM', fields: null, enumValues: (SCHEMA.SearchType!.enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value })) };
  }
  const def = SCHEMA[name];
  if (def === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: def.kind,
    fields: def.fields?.map((field) => ({ __typename: '__Field', name: field })) ?? null,
    enumValues: def.enumValues?.map((value) => ({ __typename: '__EnumValue', name: value })) ?? null,
  };
}

/** Resolve one field on an object; returns the raw value (or null). */
function resolveField(parentType: string, parent: AnyObject, field: FieldNode, ctx: Ctx): unknown {
  const { store } = ctx;
  const name = field.name;

  if (parentType === 'Query') {
    if (name === 'viewer') {
      return { __typename: 'User', login: store.viewerLogin ?? 'viewer', id: globalId('User', 1), name: store.viewerLogin ?? 'viewer', avatarUrl: '' };
    }
    if (name === 'repository') {
      const owner = String(argValue(field, 'owner', ctx) ?? '');
      const repoName = String(argValue(field, 'name', ctx) ?? '');
      const repo = store.resolveRepo(owner, repoName);
      return repo === null ? null : repoObject(store, repo);
    }
    if (name === 'node') {
      const id = String(argValue(field, 'id', ctx) ?? '');
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === parsed.numericId);
        return repo === undefined ? null : repoObject(store, repo);
      }
      if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest' || parsed.kind === 'IssueComment') {
        for (const repo of store.repos.values()) {
          if (parsed.kind === 'Issue') {
            const issue = repo.issues.find((candidate) => candidate.id === parsed.numericId);
            if (issue !== undefined) return issueObject(store, repo, issue);
          } else if (parsed.kind === 'PullRequest') {
            const pull = repo.pulls.find((candidate) => candidate.id === parsed.numericId);
            if (pull !== undefined) return pullObject(store, repo, pull);
          } else {
            for (const issue of repo.issues) {
              const comment = issue.comments.find((candidate) => candidate.id === parsed.numericId);
              if (comment !== undefined) {
                return { __typename: 'IssueComment', id: globalId('IssueComment', comment.id), body: comment.body, createdAt: comment.createdAt };
              }
            }
          }
        }
        return null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(argValue(field, 'name', ctx) ?? '');
      return typeInfo(typeName);
    }
  }

  if (parentType === 'Mutation') {
    if (name === 'createIssue') {
      const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
      const repoId = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId?.kind === 'Repository' ? [...store.repos.values()].find((candidate) => candidate.id === repoId.numericId) : undefined;
      if (repo === undefined) throw new Error('repository not found');
      const issue = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', issue: issueObject(store, repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
      const issueId = parseGlobalId(String(input.issueId ?? ''));
      let found: { repo: Repo; issue: Issue } | null = null;
      if (issueId?.kind === 'Issue') {
        for (const repo of store.repos.values()) {
          const issue = repo.issues.find((candidate) => candidate.id === issueId.numericId);
          if (issue !== undefined) {
            found = { repo, issue };
            break;
          }
        }
      }
      if (found === null) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.closedAt = new Date().toISOString();
      return { __typename: 'CloseIssuePayload', issue: issueObject(store, found.repo, found.issue) };
    }
    if (name === 'createPullRequest') {
      const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
      const repoId = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId?.kind === 'Repository' ? [...store.repos.values()].find((candidate) => candidate.id === repoId.numericId) : undefined;
      if (repo === undefined) throw new Error('repository not found');
      const head = String(input.headRefName ?? input.head ?? '');
      const base = String(input.baseRefName ?? input.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) throw new Error('head or base branch not found');
      const pull = store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(store, repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
      const pullId = parseGlobalId(String(input.pullRequestId ?? ''));
      let found: { repo: Repo; pull: Pull } | null = null;
      if (pullId?.kind === 'PullRequest') {
        for (const repo of store.repos.values()) {
          const pull = repo.pulls.find((candidate) => candidate.id === pullId.numericId);
          if (pull !== undefined) {
            found = { repo, pull };
            break;
          }
        }
      }
      if (found === null) throw new Error('pull request not found');
      if (found.pull.merged) throw new Error('pull request already merged');
      if (store.isConflicted(found.repo, found.pull)) throw new Error('pull request is not mergeable');
      store.mergePull(found.repo, found.pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(store, found.repo, found.pull) };
    }
    if (name === 'addComment') {
      const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
      const subjectId = parseGlobalId(String(input.subjectId ?? ''));
      let found: { repo: Repo; issue: Issue } | null = null;
      if (subjectId?.kind === 'Issue') {
        for (const repo of store.repos.values()) {
          const issue = repo.issues.find((candidate) => candidate.id === subjectId.numericId);
          if (issue !== undefined) {
            found = { repo, issue };
            break;
          }
        }
      }
      if (found === null) throw new Error('subject not found');
      const comment = store.createComment(found.issue, String(input.body ?? ''));
      const node = { __typename: 'IssueComment', id: globalId('IssueComment', comment.id), body: comment.body, createdAt: comment.createdAt };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node, cursor: encodeCursor(comment.id) }, comment: node };
    }
  }

  if (parentType === 'Repository') {
    const repo = parent._repo as Repo;
    if (name === 'id') return parent.id;
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return parent.nameWithOwner;
    if (name === 'description') return repo.description;
    if (name === 'owner') return { __typename: 'User', login: repo.owner ?? store.viewerLogin ?? 'viewer', id: globalId('User', 1), name: repo.owner ?? 'viewer', avatarUrl: '' };
    if (name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch };
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') {
      const number = Number(argValue(field, 'number', ctx));
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return issue === undefined ? null : issueObject(store, repo, issue);
    }
    if (name === 'issues') {
      const first = argValue(field, 'first', ctx) as number | undefined;
      const after = argValue(field, 'after', ctx) as string | undefined;
      const states = argValue(field, 'states', ctx) as string[] | undefined;
      const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
      let issues = [...repo.issues];
      if (Array.isArray(states) && states.length) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        issues = issues.filter((issue) => wanted.has(issueState(issue.state)));
      }
      const direction = orderBy?.direction === 'ASC' ? 'asc' : orderBy?.direction === 'DESC' ? 'desc' : 'asc';
      const page = pageIssues(issues, first, after, direction);
      return {
        __typename: 'IssueConnection',
        nodes: page.nodes.map((issue) => issueObject(store, repo, issue)),
        edges: page.nodes.map((issue) => ({ __typename: 'IssueEdge', node: issueObject(store, repo, issue), cursor: encodeCursor(issue.number) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: page.hasNextPage, hasPreviousPage: false, startCursor: page.startCursor, endCursor: page.endCursor },
        totalCount: issues.length,
      };
    }
    if (name === 'pullRequest') {
      const number = Number(argValue(field, 'number', ctx));
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return pull === undefined ? null : pullObject(store, repo, pull);
    }
    if (name === 'pullRequests') {
      const first = argValue(field, 'first', ctx) as number | undefined;
      const after = argValue(field, 'after', ctx) as string | undefined;
      const ordered = [...repo.pulls].sort((a, b) => b.seq - a.seq);
      let start = 0;
      if (after !== undefined && after !== null) {
        const cursorNumber = decodeCursor(String(after));
        if (cursorNumber !== null) {
          const index = ordered.findIndex((pull) => pull.number === cursorNumber);
          if (index >= 0) start = index + 1;
        }
      }
      const size = first ?? 30;
      const nodes = ordered.slice(start, start + size);
      const hasNextPage = start + size < ordered.length;
      return {
        __typename: 'PullRequestConnection',
        nodes: nodes.map((pull) => pullObject(store, repo, pull)),
        edges: nodes.map((pull) => ({ __typename: 'PullRequestEdge', node: pullObject(store, repo, pull), cursor: encodeCursor(pull.number) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor: nodes.length ? encodeCursor(nodes[0]!.number) : null, endCursor: nodes.length ? encodeCursor(nodes[nodes.length - 1]!.number) : null },
        totalCount: repo.pulls.length,
      };
    }
  }

  if (parentType === 'PullRequest') {
    const pull = parent._pull as Pull;
    const repo = parent._repo as Repo;
    if (name === 'files') {
      const first = argValue(field, 'first', ctx) as number | undefined;
      const files = store.pullFiles(repo, pull);
      const nodes = (first === undefined ? files : files.slice(0, first)).map((file) => ({ __typename: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions }));
      return {
        __typename: 'PullRequestFileConnection',
        nodes,
        edges: nodes.map((node) => ({ __typename: 'PullRequestFileEdge', node, cursor: encodeCursor(0) })),
        pageInfo: { __typename: 'PageInfo', hasNextPage: first !== undefined && files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
      };
    }
  }

  // Scalar leaf fields carried on the object itself.
  if (name in parent && !name.startsWith('_')) return parent[name];
  return undefined;
}

/** Execute a selection set against a typed value, collecting errors. */
function executeSelections(
  parentType: string,
  parent: AnyObject | null,
  selections: readonly SelectionNode[],
  ctx: Ctx,
): Record<string, unknown> | null {
  if (parent === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeName !== parentType && selection.typeName !== parent.__typename) continue;
      const nested = executeSelections(parentType, parent, selection.selections, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const def = SCHEMA[parentType];
    if (def?.fields !== undefined && !def.fields.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      out[selection.alias ?? selection.name] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(parentType, parent, selection, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[selection.alias ?? selection.name] = null;
      continue;
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      out[selection.alias ?? selection.name] = null;
      continue;
    }
    out[selection.alias ?? selection.name] = projectValue(value, selection.selections, ctx);
  }
  return out;
}

function projectValue(value: unknown, selections: readonly SelectionNode[], ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => projectValue(item, selections, ctx));
  if (isRecord(value) && typeof value.__typename === 'string') {
    return executeSelections(value.__typename, value as AnyObject, selections, ctx);
  }
  if (isRecord(value)) {
    // A connection edge or pageInfo without __typename: project by field name.
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') continue;
      out[selection.alias ?? selection.name] = projectValue((value as Record<string, unknown>)[selection.name], selection.selections, ctx);
    }
    return out;
  }
  return value;
}

/** Run one GraphQL operation body; a batched array body answers an array, in order. */
export function runGraphQL(store: Store, body: unknown): Record<string, unknown> | Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.map((entry) => runGraphQL(store, entry) as Record<string, unknown>);
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { errors: [{ message: 'A GraphQL query string is required.' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const ctx: Ctx = { store, variables, errors: [] };
  let operation: Operation;
  try {
    operation = new Parser(body.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObject = { __typename: rootType };
  const data = executeSelections(rootType, root, operation.selections, ctx);
  if (ctx.errors.length) return { data, errors: ctx.errors };
  return { data };
}
