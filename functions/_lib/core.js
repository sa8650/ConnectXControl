/* =====================================================================
   ConnectX Control — core helpers
   Crypto (PBKDF2 passwords, HMAC tokens, key hashing), JSON responses,
   validation and small shared utilities. Runs on Cloudflare Workers
   WebCrypto and Node 20+ (tests) without changes.
   ===================================================================== */

const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ITERATIONS = 100000; // Workers WebCrypto maximum

/* ---------- responses ---------- */
export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
export const fail = (message, status = 400) => json({ error: message }, status);

/* ---------- base64url / hex ---------- */
function b64u(bytes) {
  const bin = bytes instanceof Uint8Array ? bytes
    : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
    : enc.encode(bytes);
  let s = '';
  for (const b of bin) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

/* ---------- crypto primitives ---------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
export async function hmac(data, secret) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}
export async function sha256(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(value)))));
}

/* ---------- signed tokens (JWT-like HS256, no external deps) ---------- */
export async function signToken(payload, secret) {
  const h = b64u(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64u(enc.encode(JSON.stringify(payload)));
  return `${h}.${p}.${b64u(await hmac(`${h}.${p}`, secret))}`;
}
export async function verifyToken(token, secret) {
  if (!token) return null;
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) return null;
  try {
    if (b64u(await hmac(`${h}.${p}`, secret)) !== s) return null;
    const payload = JSON.parse(dec.decode(unb64u(p)));
    return payload.exp && payload.exp > Date.now() / 1000 ? payload : null;
  } catch { return null; }
}
export function bearerOf(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/* ---------- passwords (PBKDF2-SHA256) ---------- */
export async function hashPassword(password) {
  const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']), 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${b64u(bits)}`;
}
export async function checkPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!iterations || iterations > PBKDF2_ITERATIONS) return false;
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(parts[2]), iterations, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']), 256);
  return b64u(bits) === parts[3];
}

/* ---------- secret generation ---------- */
const rand = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
export const uuid = () => crypto.randomUUID();
/** Pairing code: 8 unambiguous characters, e.g. CX-4F7K-9Q2M */
export function pairingCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
/** Device tokens are opaque random strings; only their SHA-256 hash is stored. */
export const deviceToken = () => `cxd_${rand(32)}`;
/** Client API keys: cxk_live_<random>. Shown once, stored hashed. */
export const clientApiKey = () => `cxk_live_${rand(24)}`;
/** Display form of a stored system API key (never send the full key back). */
export const maskSecret = v => {
  const s = String(v || '');
  if (!s) return '';
  return s.length > 13 ? `${s.slice(0, 13)}…` : `${s.slice(0, 4)}…`;
};

/* ---------- validators ---------- */
export const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
export const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
export const isVersion = v => /^\d+(?:\.\d+){1,3}$/.test(String(v || ''));
export const isPackage = v => /^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(String(v || ''));
export const cleanPhone = v => {
  const d = String(v || '').replace(/[^0-9+]/g, '');
  return d.length >= 6 ? d : '';
};
export const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
export const bool = v => v === true || v === 1 || v === '1' || v === 'true';
export const nowIso = () => new Date().toISOString();

/* ---------- time helpers ---------- */
/** A device is "online" when it checked in within the last 3 minutes. */
export const onlineOf = lastSeen =>
  !!lastSeen && (Date.now() - new Date(lastSeen).getTime()) < 3 * 60 * 1000;

/** Start of "today" honouring a client UTC offset (minutes), like the phone app sends. */
export function dayStart(utcOffsetMinutes) {
  if (utcOffsetMinutes === null || utcOffsetMinutes === undefined || utcOffsetMinutes === '')
    return new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
  if (!/^-?[0-9]{1,4}$/.test(String(utcOffsetMinutes))) return null;
  const offset = Number(utcOffsetMinutes);
  if (offset < -720 || offset > 840) return null;
  const shifted = Date.now() + offset * 60000;
  return new Date(Math.floor(shifted / 86400000) * 86400000 - offset * 60000).toISOString();
}

/* ---------- SMS templates (used when clients send typed events) ---------- */
export const DEFAULT_TEMPLATES = {
  SALE: 'Hi {name}, thanks for your purchase at {shop}. Invoice {invoice}: total {currency} {total}, paid {currency} {paid}, due {currency} {due}.',
  PAYMENT: 'Hi {name}, {shop} received your payment of {currency} {amount} for {invoice}. Remaining due: {currency} {due}. Thank you.',
  DUE_REMINDER: 'Dear {name}, reminder from {shop} for invoice {invoice}. Outstanding due: {currency} {due}. Please settle when convenient.',
  RETURN: 'Hi {name}, your return {invoice} at {shop} is complete. Refunded: {currency} {amount}. Thank you.',
  EXCHANGE: 'Hi {name}, your exchange {invoice} at {shop} is complete. Settlement: {currency} {amount}. Thank you.',
  REFUND: 'Hi {name}, {shop} issued a refund of {currency} {amount} for {invoice}. Thank you.',
  TEST: 'ConnectX test from {shop}. Your SMS gateway is working.'
};
export function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(name|shop|invoice|total|paid|due|amount|currency)\}/g, (_, k) => vars[k] ?? '');
}
const money = v => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function templateVars(shopName, v = {}) {
  return {
    name: v.name || 'Customer',
    shop: shopName || 'Shop',
    invoice: v.invoice || v.reference || '',
    total: money(v.total), paid: money(v.paid), due: money(v.due), amount: money(v.amount ?? v.paid),
    currency: v.currency || 'BDT'
  };
}
