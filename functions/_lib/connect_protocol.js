/* Minimal signed-envelope transport retained for the authenticated legacy
   phone email-history bridge. Pairing and SMS task protocol code is retired. */
export const PROTOCOL = 'connect-app/1';
const enc = new TextEncoder();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomToken(prefix, size = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let value = '';
  for (let i = 0; i < size; i++) value += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}-${value}`;
}
export const applicationId = prefix => randomToken(prefix, 8);

function requestToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'req_' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const nonce = () => requestToken().slice(4, 28);
const nowIso = () => new Date().toISOString();

/** Accept a full Connect Endpoint or a site origin; always return …/connect. */
export function normalizeEndpoint(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { return ''; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (!url.hostname || url.username || url.password) return '';
  const path = url.pathname.replace(/\/+$/, '');
  const base = `${url.protocol}//${url.host}`;
  if (!path || path === '/') return `${base}/connect`;
  if (path === '/connect' || path.endsWith('/connect')) return `${base}${path}`;
  return `${base}${path}/connect`;
}

function stableStringify(value) {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => stableStringify(item) ?? 'null').join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
    return '{' + keys.map(key => JSON.stringify(key) + ':' + (stableStringify(value[key]) ?? 'null')).join(',') + '}';
  }
  return 'null';
}

async function sha256Hex(value) {
  const buffer = await crypto.subtle.digest('SHA-256', enc.encode(String(value)));
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(data, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(String(data)));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalString({ action, applicationId: appId, connectionId: connId, timestamp, nonce: requestNonce, payloadHash }) {
  return [PROTOCOL, action, appId || '', connId || '', timestamp || '', requestNonce || '', payloadHash || ''].join('\n');
}

export async function signEnvelope({ action, applicationId: appId, connectionId: connId = '', payload = {}, secret }) {
  const timestamp = nowIso();
  const requestNonce = nonce();
  const payloadHash = await sha256Hex(stableStringify(payload) ?? '{}');
  const signature = await hmacHex(canonicalString({
    action,
    applicationId: appId,
    connectionId: connId,
    timestamp,
    nonce: requestNonce,
    payloadHash
  }), secret);
  return {
    protocol: PROTOCOL,
    action,
    application_id: appId,
    connection_id: connId || '',
    timestamp,
    nonce: requestNonce,
    payload,
    signature
  };
}

export async function postConnect(endpoint, body, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { error: String(text || '').slice(0, 240) }; }
    return { httpOk: response.ok, status: response.status, data };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      httpOk: false,
      status: 0,
      data: { ok: false, error: aborted ? 'Connect endpoint timed out.' : (error?.message || 'Connect endpoint unreachable.') }
    };
  } finally {
    clearTimeout(timer);
  }
}
