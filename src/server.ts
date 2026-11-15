/**
 * git-forge — the one-process HTTP server: routing, auth, JSON plumbing.
 *
 * Surfaces:
 *   GET  /healthz                                  (no auth)
 *   /api/v3/*                                      REST v3, Bearer auth
 *   POST /api/graphql                              GraphQL, Bearer auth
 *   POST /mcp                                      MCP, Bearer auth
 *   /{owner}/{repo}.git/info/refs                  git smart HTTP, Bearer auth
 *   /{owner}/{repo}.git/git-upload-pack            Bearer auth
 *   /{owner}/{repo}.git/git-receive-pack           Bearer auth
 *
 * Every reply is JSON except the git surfaces (which speak pkt-lines and
 * packs); nothing ever answers HTML. A missing or empty Bearer token is
 * 401 everywhere except /healthz.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, ApiError } from './rest.ts';
import { runGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, uploadPack, receivePack } from './gitproto.ts';
import { nextRequestId } from './util.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = value === null ? '' : JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:user',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendRaw(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
  });
  response.end(body);
}

function hasAuth(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') && header.slice('Bearer '.length).trim() !== '';
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const server = createServer((request, response) => {
    void handleRequest(store, request, response).catch((error: unknown) => {
      try {
        sendJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
  return server;
}

async function handleRequest(store: Store, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';
  const path = url.pathname;

  if (path === '/healthz') {
    sendJson(response, 200, { ok: true });
    return;
  }

  // ---- git smart HTTP ----
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!hasAuth(request)) {
      sendJson(response, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = decodeSegment(gitMatch[1]!);
    const repo = decodeSegment(gitMatch[2]!);
    const service = gitMatch[3]!;
    const wantsV2 = (request.headers['git-protocol'] ?? '') === 'version=2';
    try {
      if (service === 'info/refs') {
        const serviceParam = url.searchParams.get('service') ?? '';
        const svc = serviceParam === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
        const answer = infoRefs(store, owner, repo, svc, wantsV2);
        sendRaw(response, answer.status, answer.contentType, answer.body);
        return;
      }
      const body = await readBody(request);
      if (service === 'git-upload-pack') {
        const answer = uploadPack(store, owner, repo, body, wantsV2);
        sendRaw(response, answer.status, answer.contentType, answer.body);
        return;
      }
      const answer = receivePack(store, owner, repo, body);
      sendRaw(response, answer.status, answer.contentType, answer.body);
    } catch (error) {
      sendJson(response, 400, { message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  // ---- GraphQL ----
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(response, 404, { message: 'Not Found' });
      return;
    }
    if (!hasAuth(request)) {
      sendJson(response, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(request);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(response, 400, { errors: [{ message: 'Parse error' }] });
      return;
    }
    sendJson(response, 200, runGraphQL(store, parsed));
    return;
  }

  // ---- MCP ----
  if (path === '/mcp') {
    if (method === 'DELETE') {
      response.writeHead(204, { 'x-github-request-id': nextRequestId() });
      response.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(response, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!hasAuth(request)) {
      sendJson(response, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(request);
    const answer = handleMcp(store, raw.toString('utf8'));
    if (answer === null) {
      response.writeHead(202, { 'x-github-request-id': nextRequestId(), 'content-length': 0 });
      response.end();
      return;
    }
    sendJson(response, answer.status, answer.json);
    return;
  }

  // ---- REST v3 ----
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!hasAuth(request)) {
      sendJson(response, 401, { message: 'Requires authentication' });
      return;
    }
    const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(request);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(response, 400, { message: 'Malformed JSON body' });
          return;
        }
      }
    }
    const baseUrl = `http://${request.headers.host ?? 'localhost'}`;
    try {
      const answer = handleRest(store, method, restPath, url.searchParams, body, baseUrl);
      if (answer.status === 204) {
        response.writeHead(204, { 'x-github-request-id': nextRequestId(), 'x-oauth-scopes': 'repo, read:user' });
        response.end();
        return;
      }
      const extra = answer.headers ?? {};
      const payload = JSON.stringify(answer.json);
      response.writeHead(answer.status, {
        'content-type': 'application/json; charset=utf-8',
        'x-github-request-id': nextRequestId(),
        'x-oauth-scopes': 'repo, read:user',
        'content-length': Buffer.byteLength(payload),
        ...extra,
      });
      response.end(payload);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, { message: error.message });
        return;
      }
      sendJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(response, 404, { message: 'Not Found' });
}
