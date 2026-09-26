/* In-memory D1 stub backed by better-sqlite3 (dev dependency).
   Implements the slice of the D1 API the ConnectX backend uses:
   prepare(sql).bind(...).first()/.all()/.run()  */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function makeEnv(sessionSecret = 'test-secret-key') {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = MEMORY');
  const schema = readFileSync(join(here, '..', '..', 'schema', 'connectx_schema.sql'), 'utf8');
  sqlite.exec(schema);

  const prepare = sql => {
    const stmt = sqlite.prepare(sql);
    return {
      bind(...params) {
        const bound = params.map(p => (p === undefined ? null : p));
        return {
          async first() { return stmt.get(...bound) ?? null; },
          async all() { return { results: stmt.all(...bound) }; },
          async run() { const info = stmt.run(...bound); return { meta: { changes: info.changes }, success: true }; }
        };
      }
    };
  };

  return {
    env: { DB: { prepare }, SESSION_SECRET: sessionSecret, DEFAULT_DAILY_LIMIT: '1000' },
    sqlite
  };
}

export function makeRequest(path, { method = 'GET', body, token, apiKey } = {}) {
  const url = new URL(path, 'https://control.connectx.test');
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-connectx-key'] = apiKey;
  return {
    method, url: url.href, headers: {
      get: k => headers[k.toLowerCase()] ?? null
    },
    async json() { return body ?? {}; },
    _url: url
  };
}

/** Build the ctx object our route modules expect. */
export function makeCtx(env, request, waitUntil = () => {}) {
  return {
    env,
    request,
    path: request._url.pathname.slice('/api/'.length).replace(/\/+$/, ''),
    method: request.method,
    url: request._url,
    waitUntil
  };
}

export async function readJson(response) {
  return JSON.parse(await response.text());
}
