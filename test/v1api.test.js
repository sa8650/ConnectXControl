/* Public-API (api_key) integration tests — the EMS v1 contract:
   setup → seed defaults → configure URL + emsk_ key (masked) → sign-in
   flows (wrong password / entitlement block / deactivated / missing
   scope / success) → shop refresh → dispatch loop (heartbeat + claim +
   import + dedupe + throttle) → report-back on delivery and cancel →
   pull-error surfacing. Runs on its own in-memory DB with a stubbed
   SYSTEM_FETCH implementing the mock EMS public API.                    */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, makeRequest, makeCtx, readJson } from './helpers/fakeD1.js';
import { controlRoutes } from '../functions/_lib/control.js';
import { deviceRoutes } from '../functions/_lib/device.js';

const { env, sqlite } = makeEnv('v1-test-secret');

const FULL_KEY = 'emsk_' + 'ab'.repeat(32);
const LIMITED_KEY = 'emsk_' + 'cd'.repeat(32);   // no auth:login / shops scopes
const NO_SMS_KEY = 'emsk_' + 'ef'.repeat(32);    // no sms scopes (pull must fail)
const KEY_SCOPES = {
  [FULL_KEY]: ['auth:login', 'admins:read', 'shops:read', 'sms:read', 'sms:write'],
  [LIMITED_KEY]: ['sms:read', 'sms:write'],
  [NO_SMS_KEY]: ['auth:login', 'shops:read']
};

const SHOPS = [
  { id: 'store-1', name: 'Dhaka Main', shop_code: 'DHK-1', category: 'General Store', address: 'Dhaka', phone: '+8801711111111', status: 'active' },
  { id: 'store-2', name: 'Chattogram Branch', shop_code: 'CTG-1', category: 'General Store', address: 'Chattogram', phone: '+8801822222222', status: 'active' }
];
const ADMINS = {
  'admin@ems.test': {
    password: 'ems-secret-123',
    administrator: { id: 'ems-admin-1', admin_code: '4321', name: 'EMS Admin', email: 'admin@ems.test', active: true },
    entitlement: { status: 'active', shop_limit: 5, connectx_enabled: true, connectx_daily_limit: 500 }
  },
  'blocked@ems.test': {
    password: 'ems-secret-123',
    administrator: { id: 'ems-admin-2', admin_code: '4322', name: 'Blocked', email: 'blocked@ems.test', active: true },
    entitlement: { status: 'active', shop_limit: 1, connectx_enabled: false, connectx_daily_limit: 0 }
  },
  'deact@ems.test': {
    password: 'ems-secret-123',
    administrator: { id: 'ems-admin-3', admin_code: '4323', name: 'Deactivated', email: 'deact@ems.test', active: false },
    entitlement: null
  }
};

const state = { queue: [], reports: [], heartbeats: 0, claimCalls: 0, shopsCalls: [] };
const stubJob = (over = {}) => ({
  id: crypto.randomUUID(), store_id: 'store-1', to_phone: '+8801799990001',
  recipient_name: 'Karim', recipient_type: 'customer', message_type: 'SALE',
  event_type: 'API', message_body: 'Pulled from EMS', invoice_id: null,
  status: 'queued', attempts: 0, error_message: null,
  created_at: new Date().toISOString(), sent_at: null, ...over
});

env.SYSTEM_FETCH = async (url, opts = {}) => {
  const u = new URL(url);
  const jr = (data, status = 200) => ({ ok: status < 300, status, json: async () => data, headers: new Headers() });
  if (u.host !== 'ems.v1.test') return jr({ error: 'unknown system host' }, 404);
  const auth = (opts.headers || {}).authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (u.pathname === '/api/v1') return jr({ name: 'EMS Public API', version: 'v1' });
  const scopes = KEY_SCOPES[key];
  if (!scopes) return jr({ error: 'Invalid API key.', code: 'invalid_key' }, 401);
  const has = sc => scopes.includes(sc);

  if (u.pathname === '/api/v1/heartbeat' && (opts.method || '') === 'POST') {
    state.heartbeats++;
    return jr({ ok: true, scopes, server_time: new Date().toISOString() });
  }
  if (u.pathname === '/api/v1/auth/login' && (opts.method || '') === 'POST') {
    if (!has('auth:login'))
      return jr({ error: 'This API key does not have the "auth:login" scope.', code: 'insufficient_scope' }, 403);
    const b = JSON.parse(opts.body || '{}');
    const rec = ADMINS[String(b.email || '').toLowerCase()];
    if (!rec || rec.password !== b.password)
      return jr({ error: 'Wrong email or password.', code: 'invalid_credentials' }, 401);
    if (!rec.administrator.active)
      return jr({ error: 'This administrator account is deactivated.', code: 'account_inactive' }, 403);
    return jr({ ok: true, administrator: rec.administrator, shops: SHOPS, entitlement: rec.entitlement });
  }
  if (u.pathname === '/api/v1/shops') {
    if (!has('shops:read')) return jr({ error: 'insufficient scope', code: 'insufficient_scope' }, 403);
    state.shopsCalls.push({ admin_id: u.searchParams.get('admin_id'), key });
    return jr({ items: SHOPS });
  }
  if (u.pathname === '/api/v1/sms/claim' && (opts.method || '') === 'POST') {
    if (!has('sms:write')) return jr({ error: 'insufficient scope', code: 'insufficient_scope' }, 403);
    state.claimCalls++;
    const limit = Math.min(20, Number(JSON.parse(opts.body || '{}').limit || 8));
    const claimed = [];
    for (const j of state.queue) {
      if (claimed.length >= limit) break;
      if (j.status !== 'queued') continue;
      j.status = 'sending';
      j.attempts = Number(j.attempts || 0) + 1;
      claimed.push({ ...j, shop_id: j.store_id, phone_number: j.to_phone, message: j.message_body });
    }
    return jr({ jobs: claimed });
  }
  if (u.pathname === '/api/v1/sms/report' && (opts.method || '') === 'POST') {
    if (!has('sms:write')) return jr({ error: 'insufficient scope', code: 'insufficient_scope' }, 403);
    const b = JSON.parse(opts.body || '{}');
    const j = state.queue.find(x => x.id === b.jobId);
    state.reports.push({ jobId: b.jobId, status: b.status, error: b.error || null, found: !!j });
    if (!j) return jr({ error: 'SMS job not found.' }, 404);
    j.status = b.status === 'sent' ? 'sent' : 'failed';
    return jr({ ok: true, status: j.status });
  }
  return jr({ error: 'not found' }, 404);
};

/* waitUntil collector so background report-backs can be flushed in tests */
const pending = [];
const waitUntil = p => pending.push(p);
const flush = async () => { await Promise.allSettled(pending.splice(0)); };
const control = async (path, opts = {}) =>
  readJson(await controlRoutes(makeCtx(env, makeRequest('/api/' + path, opts), waitUntil)));
const device = async (path, opts = {}) =>
  readJson(await deviceRoutes(makeCtx(env, makeRequest('/api/' + path, opts), waitUntil)));
const rewindPull = () => sqlite.exec(`UPDATE cx_systems SET last_pull_at = '2020-01-01T00:00:00Z'`);

let ownerToken = '', adminToken = '', deviceTokenValue = '', emsSystemId = '';
let shop1 = null;
const jobs = (sql, ...b) => sqlite.prepare(sql).all(...b);

test('setup seeds EMS in api_key mode with the v1 endpoints', async () => {
  const setup = await control('control/setup', {
    method: 'POST', body: { name: 'Owner', email: 'owner@v1.test', password: 'v1-secret-123' }
  });
  ownerToken = setup.token;
  assert.ok(ownerToken);
  const systems = await control('control/systems', { token: ownerToken });
  const ems = systems.find(s => s.system_key === 'ems');
  emsSystemId = ems.id;
  assert.equal(ems.auth_mode, 'api_key');
  assert.equal(ems.login_path, 'api/v1/auth/login');
  assert.equal(ems.shops_path, 'api/v1/shops');
  assert.equal(ems.api_key_set, false);
  assert.equal(ems.configured, false, 'no URL/key yet');
});

test('owner stores the system URL + API key; the key is masked everywhere', async () => {
  const res = await control(`control/systems/${emsSystemId}`, {
    method: 'PATCH', token: ownerToken,
    body: { api_url: 'https://ems.v1.test/', api_key: FULL_KEY }
  });
  assert.equal(res.system.api_url, 'https://ems.v1.test', 'trailing slash trimmed');
  assert.equal(res.system.api_key_set, true);
  assert.equal(res.system.api_key_hint, FULL_KEY.slice(0, 13) + '…');
  assert.equal(res.system.configured, true);
  assert.ok(!JSON.stringify(res).includes(FULL_KEY), 'PATCH response never echoes the key');

  const list = JSON.stringify(await control('control/systems', { token: ownerToken }));
  assert.ok(!list.includes(FULL_KEY), 'systems list never echoes the key');

  const dropdown = await device('device/systems');
  const ems = dropdown.systems.find(s => s.key === 'ems');
  assert.equal(ems.available, true);
  assert.ok(!JSON.stringify(dropdown).includes(FULL_KEY));
});

test('api_key sign-in: missing key, wrong password, entitlement block, deactivation', async () => {
  const wrong = await device('device/auth/login', {
    method: 'POST', body: { system: 'ems', email: 'admin@ems.test', password: 'nope' }
  });
  assert.equal(wrong.error, 'Wrong email or password.');

  const blocked = await device('device/auth/login', {
    method: 'POST', body: { system: 'ems', email: 'blocked@ems.test', password: 'ems-secret-123' }
  });
  assert.match(blocked.error, /not enabled on your EMS plan/i);

  const deact = await device('device/auth/login', {
    method: 'POST', body: { system: 'ems', email: 'deact@ems.test', password: 'ems-secret-123' }
  });
  assert.match(deact.error, /deactivated/i);
});

test('api_key sign-in: key without auth:login scope surfaces an owner hint', async () => {
  await control(`control/systems/${emsSystemId}`, { method: 'PATCH', token: ownerToken, body: { api_key: LIMITED_KEY } });
  const res = await device('device/auth/login', {
    method: 'POST', body: { system: 'ems', email: 'admin@ems.test', password: 'ems-secret-123' }
  });
  assert.match(res.error, /auth:login scope/i);
  await control(`control/systems/${emsSystemId}`, { method: 'PATCH', token: ownerToken, body: { api_key: FULL_KEY } });
});

test('api_key sign-in succeeds with administrator + shops in ONE call, no system token stored', async () => {
  const res = await device('device/auth/login', {
    method: 'POST', body: { system: 'ems', email: 'admin@ems.test', password: 'ems-secret-123' }
  });
  adminToken = res.token;
  assert.ok(adminToken);
  assert.equal(res.administrator.external_id, 'ems-admin-1');
  assert.equal(res.admin.email, 'admin@ems.test');
  assert.equal(res.shops.length, 2);
  shop1 = res.shops.find(s => s.external_id === 'store-1');
  assert.ok(shop1);
  const row = sqlite.prepare('SELECT system_token FROM cx_admins WHERE email = ?').get('admin@ems.test');
  assert.equal(row.system_token, null, 'api_key mode stores no system session token');
  await flush();
  assert.ok(state.heartbeats >= 1, 'sign-in fires the system heartbeat');
});

test('shop refresh calls shops_path?admin_id=… with the platform key', async () => {
  const res = await device('device/shops', { token: adminToken });
  assert.equal(res.shops.length, 2);
  const call = state.shopsCalls.at(-1);
  assert.equal(call.admin_id, 'ems-admin-1');
  assert.equal(call.key, FULL_KEY);
});

test('gateway claim runs the dispatch loop: heartbeat + fleet-wide claim + import', async () => {
  const reg = await device('device/register', {
    method: 'POST', token: adminToken,
    body: { shopId: shop1.id, deviceName: 'V1 Pixel', androidVersion: '15', appVersion: '2.1.0' }
  });
  deviceTokenValue = reg.deviceToken;
  assert.ok(deviceTokenValue);

  const j1 = stubJob({ message_body: 'Invoice ready — Dhaka' });
  const j2 = stubJob({ store_id: 'store-2', to_phone: '+8801799990002', message_body: 'Invoice ready — CTG' });
  state.queue.push(j1, j2);
  const hbBefore = state.heartbeats;

  const res = await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  assert.equal(state.claimCalls, 1);
  assert.ok(state.heartbeats > hbBefore, 'the pull heartbeats the system');
  assert.equal(res.jobs.length, 1, 'only this gateway’s shop is dispatched');
  assert.equal(res.jobs[0].phone_number, j1.to_phone);
  assert.equal(res.jobs[0].message, 'Invoice ready — Dhaka');
  const rows = jobs('SELECT * FROM cx_jobs WHERE external_job_id IS NOT NULL');
  assert.equal(rows.length, 2, 'fleet-wide import: both shops’ jobs landed');
  assert.ok(rows.every(r => r.system_id === emsSystemId));
});

test('immediate second claim is throttled (dispatch-loop cadence)', async () => {
  const res = await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  assert.equal(state.claimCalls, 1, 'no second system claim within the throttle window');
  assert.equal(res.jobs.length, 0);
});

test('delivery result is reported back to the system', async () => {
  const row = jobs(`SELECT id, external_job_id FROM cx_jobs WHERE to_phone = '+8801799990001'`)[0];
  const claimed = await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  // (job was already claimed in the dispatch-loop test — report it now)
  void claimed;
  const res = await device('device/jobs/report', {
    method: 'POST', token: deviceTokenValue, body: { jobId: row.id, status: 'sent' }
  });
  assert.equal(res.status, 'sent');
  await flush();
  const back = state.reports.find(r => r.jobId === row.external_job_id);
  assert.ok(back && back.status === 'sent' && back.found, 'EMS received the sent report');
  const emsJob = state.queue.find(j => j.id === row.external_job_id);
  assert.equal(emsJob.status, 'sent');
});

test('a re-released system job is never imported twice', async () => {
  const sent = state.queue.find(j => j.to_phone === '+8801799990001');
  sent.status = 'queued';           // EMS auto-released the stale claim
  rewindPull();
  const before = jobs('SELECT COUNT(*) AS n FROM cx_jobs').n ?? jobs('SELECT COUNT(*) AS n FROM cx_jobs')[0].n;
  await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  assert.equal(state.claimCalls, 2);
  const after = jobs('SELECT COUNT(*) AS n FROM cx_jobs')[0].n;
  assert.equal(after, before, 'dedupe on external_job_id kept the job count stable');
});

test('control-side cancel of a pulled job reports failed back to the system', async () => {
  const j3 = stubJob({ store_id: 'store-2', to_phone: '+8801799990003', message_body: 'Cancel me' });
  state.queue.push(j3);
  rewindPull();
  await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  const row = jobs('SELECT id FROM cx_jobs WHERE external_job_id = ?', j3.id)[0];
  assert.ok(row, 'job imported');
  const res = await control(`control/jobs/${row.id}/cancel`, { method: 'POST', token: ownerToken });
  assert.equal(res.cancelled, true);
  await flush();
  const back = state.reports.find(r => r.jobId === j3.id);
  assert.ok(back && back.status === 'failed', 'EMS received the failed report');
  assert.match(back.error, /Cancelled in ConnectX Control/);
});

test('pull failures surface as last_pull_error and recover', async () => {
  await control(`control/systems/${emsSystemId}`, { method: 'PATCH', token: ownerToken, body: { api_key: NO_SMS_KEY } });
  rewindPull();
  const res = await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  assert.ok(Array.isArray(res.jobs), 'the gateway poll itself still succeeds');
  let systems = await control('control/systems', { token: ownerToken });
  let ems = systems.find(s => s.id === emsSystemId);
  assert.match(ems.last_pull_error || '', /insufficient/i);
  assert.equal(ems.configured, true);

  await control(`control/systems/${emsSystemId}`, { method: 'PATCH', token: ownerToken, body: { api_key: FULL_KEY } });
  rewindPull();
  await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  systems = await control('control/systems', { token: ownerToken });
  ems = systems.find(s => s.id === emsSystemId);
  assert.equal(ems.last_pull_error, null, 'clean pull clears the error');
  assert.ok(!JSON.stringify(systems).includes(NO_SMS_KEY));
  assert.ok(!JSON.stringify(systems).includes(LIMITED_KEY));
});

test('mode switch back to federated swaps the endpoint defaults', async () => {
  const res = await control(`control/systems/${emsSystemId}`, {
    method: 'PATCH', token: ownerToken, body: { auth_mode: 'federated' }
  });
  assert.equal(res.system.login_path, 'api/auth/admin/login');
  assert.equal(res.system.shops_path, 'api/connectx/gateway/shops');
  assert.equal(res.system.auth_mode, 'federated');
});
