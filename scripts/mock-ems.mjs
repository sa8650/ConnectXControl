/* Mock "EMS-style" external system for local end-to-end testing.

   Implements BOTH integration contracts ConnectX supports server-side:

   Federated (legacy):
     POST /api/auth/admin/login        {email,password} → {token,user,role}
     GET  /api/connectx/gateway/shops  (Bearer token)   → {administrator,shops}

   Public API v1 (api_key mode — mirrors the real EMS API.md):
     GET  /api/v1                      metadata (no auth)
     GET  /api/v1/ping                 key validation (Bearer emsk_…)
     POST /api/v1/heartbeat            {ok,scopes,server_time}
     POST /api/v1/auth/login           {email,password} + Bearer key
                                       → {ok,administrator,shops,entitlement}
     GET  /api/v1/shops?admin_id=…     → {items:[…]}
     POST /api/v1/sms/send?shop_id=…   → queue a job (like the EMS UI does)
     POST /api/v1/sms/claim {limit}    → {jobs:[…]}  (queued → sending)
     POST /api/v1/sms/report           {jobId,status,error}
     GET  /api/v1/sms/queue            → {items:[…]}

   Test sinks:
     POST /hooks/connectx              → webhook sink
     GET  /__webhooks                  → recorded webhooks
     GET  /__reports                   → recorded sms/report calls
     GET  /__heartbeat                 → heartbeat counter

   Keys:
     FULL_KEY    — all ConnectX-recommended scopes
     LIMITED_KEY — sms scopes only (NO auth:login) for negative tests

   Run: node scripts/mock-ems.mjs  (listens on 127.0.0.1:8799) */
import http from 'node:http';
import crypto from 'node:crypto';

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowIso = () => new Date().toISOString();

export const FULL_KEY = 'emsk_' + 'ab'.repeat(32);      // 64 hex chars, like the real EMS
export const LIMITED_KEY = 'emsk_' + 'cd'.repeat(32);   // no auth:login scope
const KEY_SCOPES = {
  [FULL_KEY]: ['auth:login', 'admins:read', 'shops:read', 'sms:read', 'sms:write'],
  [LIMITED_KEY]: ['sms:read', 'sms:write']
};

const ADMIN = { email: 'admin@ems.test', password: 'ems-secret-123' };
const token = () => `${b64u({ alg: 'HS256' })}.${b64u({ id: 'ems-admin-1', role: 'admin', exp: Math.floor(Date.now() / 1000) + 28800 })}.mocksig`;
const webhooks = [];
const reports = [];
let heartbeats = 0;

const SHOPS = [
  { id: 'store-1', name: 'Dhaka Main', address: 'Gulshan 1, Dhaka', phone: '+8801711111111', shop_code: 'DHK-1', status: 'active', category: 'General Store' },
  { id: 'store-2', name: 'Chattogram Branch', address: 'Khulshi, Chattogram', phone: '+8801822222222', shop_code: 'CTG-1', status: 'active', category: 'General Store' }
];
const publicShop = s => ({ id: s.id, name: s.name, shop_code: s.shop_code, category: s.category || null, address: s.address || null, phone: s.phone || null, status: s.status });

/* v1-style administrator accounts: email → profile + entitlement */
const V1_ADMINS = {
  'admin@ems.test': {
    password: 'ems-secret-123',
    administrator: { id: 'ems-admin-1', admin_code: '4321', name: 'EMS Admin', email: 'admin@ems.test', phone: null, address: null, active: true, created_at: '2025-01-01T00:00:00Z' },
    entitlement: { status: 'active', shop_limit: 5, connectx_enabled: true, connectx_daily_limit: 500, starts_at: '2025-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' }
  },
  'blocked@ems.test': {
    password: 'ems-secret-123',
    administrator: { id: 'ems-admin-2', admin_code: '4322', name: 'Blocked Admin', email: 'blocked@ems.test', phone: null, address: null, active: true, created_at: '2025-01-01T00:00:00Z' },
    entitlement: { status: 'active', shop_limit: 1, connectx_enabled: false, connectx_daily_limit: 0, starts_at: '2025-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' }
  },
  'deact@ems.test': {
    password: 'ems-secret-123',
    administrator: { id: 'ems-admin-3', admin_code: '4323', name: 'Deactivated', email: 'deact@ems.test', phone: null, address: null, active: false, created_at: '2025-01-01T00:00:00Z' },
    entitlement: null
  }
};

/* in-memory SMS queue, shaped like the EMS connectx_sms_messages table */
const smsJobs = [];
const publicSms = r => ({
  id: r.id, to_phone: r.to_phone, recipient_name: r.recipient_name || null,
  recipient_type: r.recipient_type || null, message_type: r.message_type || null,
  event_type: r.event_type || r.message_type || null, message_body: r.message_body,
  invoice_id: r.invoice_id || null, status: r.status, attempts: Number(r.attempts || 0),
  error_message: r.error_message || null, created_at: r.created_at, sent_at: r.sent_at || null
});

function authKey(req) {
  let raw = req.headers['x-api-key'] || '';
  if (!raw) {
    const a = req.headers.authorization || '';
    if (a.toLowerCase().startsWith('bearer ')) raw = a.slice(7).trim();
  }
  return KEY_SCOPES[raw] ? { raw, scopes: KEY_SCOPES[raw] } : null;
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://127.0.0.1:8799');
    const p = url.pathname;
    const body = () => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };

    /* ---------------- legacy federated contract ---------------- */
    if (p === '/api/auth/admin/login' && req.method === 'POST') {
      const b = body();
      if (b.email === ADMIN.email && b.password === ADMIN.password)
        return send(200, { token: token(), user: { id: 'ems-admin-1', admin_code: '4321', name: 'EMS Admin', email: b.email }, role: 'admin' });
      if (b.email === 'deact@ems.test')
        return send(403, { error: 'Your administrator account is deactivated. Contact EMS support.' });
      return send(401, { error: 'Wrong email or password.' });
    }
    if (p === '/api/connectx/gateway/shops' && req.method === 'GET') {
      if (!(req.headers.authorization || '').startsWith('Bearer ')) return send(401, { error: 'Expired' });
      return send(200, { administrator: { id: 'ems-admin-1', admin_code: '4321', name: 'EMS Admin', email: ADMIN.email }, shops: SHOPS });
    }
    /* the real EMS answers 410 + retirement text on the old ConnectX Android endpoints */
    if (p.startsWith('/api/connectx/gateway/') && p !== '/api/connectx/gateway/shops') {
      return send(410, { error: 'This ConnectX Android endpoint has been retired. Contract through the EMS public API (/api/v1) with an API key. See API.md.', code: 'endpoint_retired' });
    }

    /* ---------------- public API v1 ---------------- */
    if (p === '/api/v1' && req.method === 'GET') {
      return send(200, { name: 'EMS Public API', version: 'v1', documentation: 'API.md', authentication: 'Authorization: Bearer <emsk_…>  (or X-API-Key header)', scopes: ['read', 'write', 'auth:login', 'shops:read', 'sms:read', 'sms:write'] });
    }
    if (!p.startsWith('/api/v1/') && p !== '/api/v1') { /* fall through to sinks below */ }
    else {
      const key = authKey(req);
      if (!key) {
        const missing = !(req.headers.authorization || req.headers['x-api-key']);
        return send(401, missing
          ? { error: 'Missing API key. Send "Authorization: Bearer emsk_…" or "X-API-Key".', code: 'missing_key' }
          : { error: 'Invalid API key.', code: 'invalid_key' });
      }
      const has = sc => key.scopes.includes(sc);

      if (p === '/api/v1/ping' && req.method === 'GET')
        return send(200, { ok: true, name: 'Mock EMS key', key_prefix: key.raw.slice(0, 13), scopes: key.scopes, shop_locked: false, expires_at: null, server_time: nowIso() });

      if (p === '/api/v1/heartbeat' && req.method === 'POST') {
        heartbeats++;
        return send(200, { ok: true, scopes: key.scopes, server_time: nowIso() });
      }

      if (p === '/api/v1/auth/login' && req.method === 'POST') {
        if (!has('auth:login')) return send(403, { error: 'This API key does not have the "auth:login" scope.', code: 'insufficient_scope' });
        const b = body();
        const email = String(b.email || '').trim().toLowerCase();
        const rec = V1_ADMINS[email];
        if (!rec || rec.password !== String(b.password || ''))
          return send(401, { error: 'Wrong email or password.', code: 'invalid_credentials' });
        if (!rec.administrator.active)
          return send(403, { error: 'This administrator account is deactivated.', code: 'account_inactive' });
        return send(200, { ok: true, administrator: rec.administrator, shops: SHOPS.map(publicShop), entitlement: rec.entitlement });
      }

      if (p === '/api/v1/shops' && req.method === 'GET') {
        if (!has('shops:read')) return send(403, { error: 'insufficient scope', code: 'insufficient_scope' });
        const adminId = url.searchParams.get('admin_id') || '';
        const items = adminId === 'ems-admin-1' || !adminId ? SHOPS.map(publicShop) : [];
        return send(200, { items });
      }

      if (p === '/api/v1/sms/send' && req.method === 'POST') {
        if (!has('sms:write')) return send(403, { error: 'insufficient scope', code: 'insufficient_scope' });
        const shopId = url.searchParams.get('shop_id') || 'store-1';
        const b = body();
        const job = {
          id: crypto.randomUUID(), store_id: shopId,
          to_phone: String(b.phone || ''), recipient_name: b.recipientName || null,
          recipient_type: b.recipientType || 'manual', message_type: b.messageType || 'API Message',
          event_type: 'API', message_body: String(b.message || ''), invoice_id: b.invoiceId || null,
          status: 'queued', attempts: 0, error_message: null,
          created_at: nowIso(), sent_at: null, claimed_at: null
        };
        smsJobs.push(job);
        return send(201, { ok: true, id: job.id, status: 'queued' });
      }

      if (p === '/api/v1/sms/queue' && req.method === 'GET') {
        if (!has('sms:read')) return send(403, { error: 'insufficient scope', code: 'insufficient_scope' });
        return send(200, { shop_id: null, items: smsJobs.filter(j => j.status === 'queued').map(j => ({ ...publicSms(j), shop_id: j.store_id })) });
      }

      if (p === '/api/v1/sms/claim' && req.method === 'POST') {
        if (!has('sms:write')) return send(403, { error: 'insufficient scope', code: 'insufficient_scope' });
        const limit = Math.min(20, Math.max(1, Number(body().limit || 8)));
        const claimed = [];
        for (const job of smsJobs) {
          if (claimed.length >= limit) break;
          if (job.status !== 'queued') continue;
          job.status = 'sending';
          job.claimed_at = nowIso();
          job.attempts = Number(job.attempts || 0) + 1;
          claimed.push({ ...publicSms(job), shop_id: job.store_id, attempts: job.attempts, phone_number: job.to_phone, message: job.message_body });
        }
        return send(200, { jobs: claimed });
      }

      if (p === '/api/v1/sms/report' && req.method === 'POST') {
        if (!has('sms:write')) return send(403, { error: 'insufficient scope', code: 'insufficient_scope' });
        const b = body();
        const job = smsJobs.find(j => j.id === String(b.jobId || b.id || ''));
        reports.push({ at: nowIso(), jobId: b.jobId || b.id || null, status: b.status, error: b.error || null, found: !!job });
        if (!job) return send(404, { error: 'SMS job not found.' });
        job.status = b.status === 'sent' ? 'sent' : 'failed';
        job.error_message = job.status === 'failed' ? String(b.error || 'SMS could not be sent') : null;
        if (job.status === 'sent') job.sent_at = nowIso();
        return send(200, { ok: true, status: job.status, shop_id: job.store_id });
      }
    }

    /* ---------------- sinks ---------------- */
    if (p === '/hooks/connectx' && req.method === 'POST') {
      webhooks.push({ headers: { event: req.headers['x-connectx-event'], sig: req.headers['x-connectx-signature'] }, body: body() });
      return send(200, { ok: true });
    }
    if (p === '/__webhooks') return send(200, { count: webhooks.length, webhooks });
    if (p === '/__reports') return send(200, { count: reports.length, reports, jobs: smsJobs.map(j => ({ id: j.id, status: j.status, error_message: j.error_message })) });
    if (p === '/__heartbeat') return send(200, { count: heartbeats });
    send(404, { error: 'not found' });
  });
}).listen(8799, '127.0.0.1', () => console.log('mock EMS listening on http://127.0.0.1:8799 (federated + public API v1)'));
