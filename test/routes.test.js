/* End-to-end route tests on a real (in-memory) SQLite database.
   Walks the full platform lifecycle:
   setup → systems → federated admin login (stubbed EMS-style system) →
   shops sync → device register → API key → client SMS → claim → report →
   cancel race → pairing code → email history → releases → permissions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeRequest, makeCtx, readJson } from './helpers/fakeD1.js';
import { controlRoutes } from '../functions/_lib/control.js';
import { deviceRoutes } from '../functions/_lib/device.js';
import { clientRoutes } from '../functions/_lib/client.js';
import { publicReleaseRoutes } from '../functions/_lib/releases.js';

const { env, sqlite } = makeEnv();

/* ---------- stub of an EMS-style external system ----------
   POST /api/auth/admin/login  {email,password} → {token,user,role}
   GET  /api/connectx/gateway/shops (Bearer)    → {administrator,shops}  */
const EMS_ADMIN = { email: 'admin@ems.test', password: 'ems-secret-123' };
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (expSecondsFromNow = 3600) =>
  `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ id: 'ems-admin-1', role: 'admin', exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
let shopsTokenValid = true;

env.SYSTEM_FETCH = async (url, opts = {}) => {
  const u = new URL(url);
  const jsonResponse = (data, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => data,
    headers: new Headers()
  });
  if (u.host !== 'ems.test') return jsonResponse({ error: 'unknown system host' }, 404);
  if (u.pathname === '/api/auth/admin/login' && (opts.method || 'GET') === 'POST') {
    const b = JSON.parse(opts.body || '{}');
    if (b.email === EMS_ADMIN.email && b.password === EMS_ADMIN.password)
      return jsonResponse({
        token: fakeJwt(),
        user: { id: 'ems-admin-1', admin_code: '4321', name: 'EMS Admin', email: b.email, phone: '+8801700000000' },
        role: 'admin'
      });
    return jsonResponse({ error: 'Wrong email or password.' }, 401);
  }
  if (u.pathname === '/api/connectx/gateway/shops') {
    const auth = (opts.headers || {}).authorization || '';
    if (!shopsTokenValid || !auth.startsWith('Bearer ')) return jsonResponse({ error: 'Expired' }, 401);
    return jsonResponse({
      administrator: { id: 'ems-admin-1', admin_code: '4321', name: 'EMS Admin', email: EMS_ADMIN.email },
      shops: [
        { id: 'store-1', name: 'Dhaka Main', address: 'Dhaka', phone: '+8801711111111', shop_code: 'DHK-1', status: 'active', category: 'General Store' },
        { id: 'store-2', name: 'Chattogram Branch', address: 'Chattogram', phone: '+8801822222222', shop_code: 'CTG-1', status: 'active', category: 'General Store' }
      ]
    });
  }
  return jsonResponse({ error: 'not found' }, 404);
};

const control = async (path, opts = {}) =>
  readJson(await controlRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));
const device = async (path, opts = {}) =>
  readJson(await deviceRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));
const client = async (path, opts = {}) =>
  readJson(await clientRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));
const publicApi = async (path, opts = {}) =>
  readJson(await publicReleaseRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));

let ownerToken = '', operatorToken = '', adminToken = '', apiKey = '';
let emsSystemId = '', shop1 = null, shop2 = null, deviceId = '', deviceTokenValue = '';

test('bootstrap reports uninitialized, then setup creates the owner + seeded systems', async () => {
  const before = await control('control/bootstrap');
  assert.equal(before.initialized, false);

  const weak = await control('control/setup', { method: 'POST', body: { name: 'Owner', email: 'owner@connectx.test', password: 'short' } });
  assert.ok(weak.error, 'weak password must be rejected');

  const res = await control('control/setup', { method: 'POST', body: { name: 'Platform Owner', email: 'owner@connectx.test', password: 'super-secret-123' } });
  assert.ok(res.token, 'setup returns a session token');
  assert.equal(res.operator.role, 'owner');
  ownerToken = res.token;

  const again = await control('control/setup', { method: 'POST', body: { name: 'X', email: 'x@y.test', password: 'super-secret-123' } });
  assert.ok(again.error, 'second setup must fail');

  const systems = await control('control/systems', { token: ownerToken });
  assert.deepEqual(systems.map(s => s.system_key).sort(), ['careos', 'ems', 'influenceos', 'plugx']);
  assert.ok(systems.every(s => s.configured === false), 'no API URLs configured yet');
  emsSystemId = systems.find(s => s.system_key === 'ems').id;

  // no workspaces table anywhere anymore
  const gone = await control('control/workspaces', { token: ownerToken });
  assert.match(gone.error, /Unknown/);
});

test('login works for the owner; wrong password fails', async () => {
  const bad = await control('control/auth/login', { method: 'POST', body: { email: 'owner@connectx.test', password: 'nope-nope-nope' } });
  assert.equal(bad.error, 'Wrong email or password.');
  const ok = await control('control/auth/login', { method: 'POST', body: { email: 'owner@connectx.test', password: 'super-secret-123' } });
  assert.ok(ok.token);
});

test('owner creates an operator account; operator cannot manage systems', async () => {
  const created = await control('control/operators', {
    method: 'POST', token: ownerToken,
    body: { name: 'Shop Operator', email: 'op@connectx.test', password: 'operator-secret-1', role: 'operator' }
  });
  assert.equal(created.operator.role ?? 'operator', 'operator');
  const login = await control('control/auth/login', { method: 'POST', body: { email: 'op@connectx.test', password: 'operator-secret-1' } });
  operatorToken = login.token;

  const forbidden = await control('control/systems', { method: 'POST', token: operatorToken, body: { name: 'Sneaky', system_key: 'sneaky' } });
  assert.match(forbidden.error, /owner/i);
  const forbiddenPatch = await control(`control/systems/${emsSystemId}`, { method: 'PATCH', token: operatorToken, body: { api_url: 'https://x.test' } });
  assert.match(forbiddenPatch.error, /owner/i);
});

test('phone sees the system list; unconfigured systems are marked unavailable', async () => {
  const list = await device('device/systems');
  assert.equal(list.systems.length, 4);
  assert.ok(list.systems.every(s => s.available === false));

  // owner connects EMS
  const bad = await control(`control/systems/${emsSystemId}`, { method: 'PATCH', token: ownerToken, body: { api_url: 'not-a-url' } });
  assert.ok(bad.error, 'invalid API URL rejected');
  const patched = await control(`control/systems/${emsSystemId}`, {
    method: 'PATCH', token: ownerToken,
    body: { api_url: 'https://ems.test/', webhook_url: 'https://ems.test/hooks/connectx' }
  });
  assert.equal(patched.system.api_url, 'https://ems.test', 'trailing slash trimmed');

  const after = await device('device/systems');
  const ems = after.systems.find(s => s.key === 'ems');
  assert.equal(ems.available, true);
  assert.ok(!JSON.stringify(after).includes('ems.test'), 'system list never exposes API URLs');
});

test('federated login: wrong password passes through; unconfigured system blocked', async () => {
  const bad = await device('device/auth/login', { method: 'POST', body: { system: 'ems', email: EMS_ADMIN.email, password: 'wrong' } });
  assert.equal(bad.error, 'Wrong email or password.');

  const notReady = await device('device/auth/login', { method: 'POST', body: { system: 'careos', email: 'a@b.test', password: 'x' } });
  assert.match(notReady.error, /not connected yet/i);

  const missing = await device('device/auth/login', { method: 'POST', body: { email: 'a@b.test', password: 'x' } });
  assert.match(missing.error, /Select the system/i);
});

test('federated login: EMS admin authenticates and shops sync', async () => {
  const res = await device('device/auth/login', {
    method: 'POST', body: { system: 'ems', email: EMS_ADMIN.email, password: EMS_ADMIN.password }
  });
  assert.ok(res.token, 'ConnectX admin session token issued');
  assert.equal(res.system.key, 'ems');
  assert.equal(res.admin.email, EMS_ADMIN.email);
  assert.equal(res.administrator.name, 'EMS Admin');
  assert.equal(res.shops.length, 2);
  assert.deepEqual(res.shops.map(s => s.name).sort(), ['Chattogram Branch', 'Dhaka Main']);
  assert.equal(res.shops.find(s => s.external_id === 'store-1').shop_code, 'DHK-1');
  assert.ok(res.shops.every(s => s.connected === false));
  adminToken = res.token;
  shop1 = res.shops.find(s => s.external_id === 'store-1');
  shop2 = res.shops.find(s => s.external_id === 'store-2');

  // no password stored anywhere; system token cached for shop re-sync
  const adminRow = sqlite.prepare('SELECT * FROM cx_admins').get();
  assert.equal(adminRow.password_hash, undefined);
  assert.ok(adminRow.system_token, 'system token cached');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM cx_shops').get().n, 2);

  // re-sync through the admin session
  const shops = await device('device/shops', { token: adminToken });
  assert.equal(shops.shops.length, 2);
  const bogus = await device('device/shops', { token: 'nonsense' });
  assert.ok(bogus.error);
});

test('admin registers a gateway device for a shop', async () => {
  const reg = await device('device/register', {
    method: 'POST', token: adminToken,
    body: { shopId: shop1.id, deviceName: 'Pixel 8', androidVersion: '15', appVersion: '2.1.0', simSubscriptionId: 1, simCarrier: 'Grameenphone', phoneNumber: '+8801711111111' }
  });
  assert.match(reg.deviceToken, /^cxd_/);
  assert.equal(reg.shop.name, 'Dhaka Main');
  assert.equal(reg.system.key, 'ems');
  assert.equal(reg.administrator.email, EMS_ADMIN.email);
  assert.equal(reg.device.status, 'pending_test');
  assert.ok(reg.device.is_primary, 'first device of a shop becomes primary');
  deviceId = reg.device.id;
  deviceTokenValue = reg.deviceToken;

  const wrongShop = await device('device/register', { method: 'POST', token: adminToken, body: { shopId: 'does-not-exist' } });
  assert.ok(wrongShop.error);
  const noSession = await device('device/register', { method: 'POST', body: { shopId: shop1.id } });
  assert.match(noSession.error, /sign-in required/i);

  const me = await device('device/me', { token: deviceTokenValue });
  assert.equal(me.device.device_name, 'Pixel 8');
  assert.equal(me.shop.name, 'Dhaka Main');
  assert.equal(me.system.key, 'ems');
  assert.deepEqual(me.connectedShopIds, [shop1.id]);
});

test('owner issues an API key for the EMS system', async () => {
  const res = await control(`control/systems/${emsSystemId}/keys`, {
    method: 'POST', token: ownerToken,
    body: { label: 'EMS production', daily_limit: 4 }
  });
  assert.match(res.api_key, /^cxk_live_/);
  assert.equal(res.key.key_hash, undefined, 'hash must never be returned');
  apiKey = res.api_key;

  const forbidden = await control(`control/systems/${emsSystemId}/keys`, { method: 'POST', token: operatorToken, body: {} });
  assert.match(forbidden.error, /owner/i);
});

test('client API rejects unknown/missing keys', async () => {
  const noKey = await client('client/v1/ping');
  assert.match(noKey.error, /Missing ConnectX API key/);
  const badKey = await client('client/v1/ping', { apiKey: 'cxk_live_bogus' });
  assert.match(badKey.error, /Unknown/);
});

test('client ping + SMS send by shop + idempotency + aliases + daily limit', async () => {
  const ping = await client('client/v1/ping', { apiKey });
  assert.equal(ping.ok, true);
  assert.equal(ping.system.key, 'ems');

  const noShop = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: '+8801712345678', message: 'x' } });
  assert.match(noShop.error, /shop is required/i);
  const bad = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '12', message: 'x' } });
  assert.ok(bad.error, 'too-short phone rejected');
  const noMsg = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801712345678' } });
  assert.ok(noMsg.error, 'missing message without event_type rejected');

  const sent = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { shop: 'store-1', to: '+8801712345678', recipient_name: 'Rahim', message: 'Invoice INV-1 confirmed.', message_type: 'SALE', reference_number: 'INV-1', idempotency_key: 'SALE:INV-1' }
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 'queued');
  assert.equal(sent.shop, 'store-1', 'response echoes the caller shop reference');
  assert.equal(sent.message, '✓ SMS queued for ConnectX');
  assert.equal(sent.id, sent.job_id);

  const dup = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { shop: 'store-1', to: '+8801712345678', message: 'Invoice INV-1 confirmed.', idempotency_key: 'SALE:INV-1' }
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.job_id, sent.job_id);

  // EMS-style camelCase aliases + /sms/send alias path
  const camel = await client('client/v1/sms/send', {
    method: 'POST', apiKey,
    body: { storeId: 'store-1', toPhone: '+8801799999999', messageBody: 'Thanks!', recipientName: 'Karim', messageType: 'SALE', invoiceNumber: 'INV-2', idempotencyKey: 'SALE:INV-2' }
  });
  assert.equal(camel.ok, true);
  const camelRow = sqlite.prepare('SELECT * FROM cx_jobs WHERE id = ?').get(camel.id);
  assert.equal(camelRow.recipient_name, 'Karim');
  assert.equal(camelRow.reference_number, 'INV-2');

  // 5-second duplicate guard (same destination + same body, no idempotency key)
  const dupGuard = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801799999999', message: 'Thanks!' } });
  assert.match(dupGuard.error, /Duplicate SMS detected/);

  // template rendering via event_type (uses the shop name)
  const templated = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { shop: 'store-2', to: '+8801788880000', event_type: 'TEST', recipient_name: 'Karim' }
  });
  assert.equal(templated.ok, true);
  const tRow = sqlite.prepare("SELECT message_body FROM cx_jobs WHERE event_type='TEST' ORDER BY created_at DESC LIMIT 1").get();
  assert.match(tRow.message_body, /ConnectX test from Chattogram Branch/);

  // daily limit = 4 → this is the fourth job, the next one is blocked
  const fourth = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801700000001', message: 'fourth' } });
  assert.equal(fourth.ok, true);
  const limited = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801700000099', message: 'over limit' } });
  assert.match(limited.error, /Daily ConnectX limit/);
});

test('unknown shop auto-registers on first message', async () => {
  sqlite.prepare('UPDATE cx_api_keys SET daily_limit = 100').run();
  const sent = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { shop: 'store-77', shop_name: 'Sylhet Branch', to: '+8801712340000', message: 'hello new shop' }
  });
  assert.equal(sent.ok, true);
  const row = sqlite.prepare("SELECT * FROM cx_shops WHERE external_id = 'store-77'").get();
  assert.ok(row, 'shop row auto-created');
  assert.equal(row.name, 'Sylhet Branch');
  assert.equal(row.system_id, emsSystemId);
});

test('pairing code flow: generate for a shop → pair phone → token works', async () => {
  const code = await control('control/devices/pairing-code', { method: 'POST', token: operatorToken, body: { shop_id: shop2.id, ttl_minutes: 15 } });
  assert.match(code.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(code.shop.name, 'Chattogram Branch');

  const used = await device('device/pair', { method: 'POST', body: { code: 'AAAA-BBBB' } });
  assert.ok(used.error, 'unknown code rejected');

  const paired = await device('device/pair', {
    method: 'POST',
    body: { code: code.code, deviceName: 'Galaxy A15', androidVersion: '14', appVersion: '2.1.0', simCarrier: 'Robi', phoneNumber: '+8801822222222', simSubscriptionId: 2 }
  });
  assert.match(paired.deviceToken, /^cxd_/);
  assert.equal(paired.shop.name, 'Chattogram Branch');
  assert.equal(paired.system.key, 'ems');
  assert.equal(paired.administrator, null);

  const replay = await device('device/pair', { method: 'POST', body: { code: code.code } });
  assert.ok(replay.error, 'code cannot be reused');
});

test('claim → send → report lifecycle with race-safe claiming', async () => {
  const before = await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  assert.equal(before.error, undefined, 'pending_test device can claim (setup test SMS)');
  const n = before.jobs.length;
  assert.ok(n >= 1);
  for (const j of before.jobs) {
    assert.ok(j.phone_number && j.message, 'claimed job has payload');
    assert.equal(j.shop_id, shop1.id);
    assert.equal(j.shop_external_id, 'store-1');
    assert.ok(['ems', null].includes(j.system_key), 'system info present');
  }

  // a second device on the SAME shop gets nothing (jobs already claimed)
  const otherReg = await device('device/register', {
    method: 'POST', token: adminToken,
    body: { shopId: shop1.id, deviceName: 'Second phone', androidVersion: '13', simCarrier: 'Banglalink', phoneNumber: '+8801933333333' }
  });
  assert.ok(otherReg.device.is_primary === false || otherReg.device.is_primary === 0, 'second device is not primary');
  const second = await device('device/jobs/claim', { method: 'POST', token: otherReg.deviceToken, body: { limit: 10 } });
  assert.equal(second.jobs.length, 0);

  // report each claimed job
  for (const [i, j] of before.jobs.entries()) {
    const status = i === 0 ? 'failed' : 'sent';
    const rep = await device('device/jobs/report', {
      method: 'POST', token: deviceTokenValue,
      body: { jobId: j.id, status, error: status === 'failed' ? 'RADIO_OFF' : undefined }
    });
    assert.equal(rep.status, status);
  }
  const unknown = await device('device/jobs/report', { method: 'POST', token: deviceTokenValue, body: { jobId: 'not-a-job', status: 'sent' } });
  assert.ok(unknown.error);

  // device becomes active after report
  const me = await device('device/me', { token: deviceTokenValue });
  assert.equal(me.device.status, 'active');
});

test('cancel is conditional: only queued jobs, race-safe', async () => {
  const job = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801755555555', message: 'cancel me' } });
  assert.equal(job.ok, true);

  const cancel = await device('device/jobs/cancel', { method: 'POST', token: deviceTokenValue, body: { jobId: job.job_id } });
  assert.equal(cancel.cancelled, true);
  const again = await device('device/jobs/cancel', { method: 'POST', token: deviceTokenValue, body: { jobId: job.job_id } });
  assert.ok(again.error, 'already-cancelled job cannot cancel again');

  const missing = await device('device/jobs/cancel', { method: 'POST', token: deviceTokenValue, body: { jobId: 'nope' } });
  assert.ok(missing.error);
});

test('stale sending jobs get re-queued on next claim', async () => {
  sqlite.prepare("UPDATE cx_jobs SET status='sending', claimed_at='2020-01-01T00:00:00.000Z' WHERE to_phone='+8801755555555'").run();
  const claim = await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  assert.ok(claim.jobs.some(j => j.phone_number === '+8801755555555'), 'stale job re-queued and claimable');
});

test('device stats + activity reflect reality', async () => {
  const stats = await device('device/stats?utcOffsetMinutes=360', { token: deviceTokenValue });
  assert.ok(stats.sent >= 1);
  assert.ok(stats.failed >= 1);
  assert.equal(stats.shop.name, 'Dhaka Main');
  assert.equal(stats.system.key, 'ems');

  const act = await device('device/activity?range=7d', { token: deviceTokenValue });
  assert.ok(act.items.length >= 3);
  assert.ok(act.items.every(i => i.id && i.status));
});

test('control jobs list + retry failed job + console manual send', async () => {
  const list = await control('control/jobs?status=failed', { token: operatorToken });
  assert.ok(list.items.length >= 1);
  const failedJob = list.items[0];
  assert.equal(failedJob.shop_name, 'Dhaka Main');
  const retry = await control(`control/jobs/${failedJob.id}/retry`, { method: 'POST', token: operatorToken });
  assert.equal(retry.ok, true);
  const cancelRace = await control(`control/jobs/${failedJob.id}/cancel`, { method: 'POST', token: operatorToken });
  assert.equal(cancelRace.ok, true, 're-queued job can be cancelled from console');

  const manual = await control('control/jobs', { method: 'POST', token: operatorToken, body: { shop_id: shop1.id, to: '+8801788888888', message: 'from the console' } });
  assert.equal(manual.ok, true);
  assert.equal(manual.job.status, 'queued');
  assert.ok(manual.job.to.includes('880178'));
});

test('email records: client logs history, device reads it paginated', async () => {
  const rec = await client('client/v1/email', {
    method: 'POST', apiKey,
    body: { shop: 'store-1', to_emails: ['rahim@example.com'], cc_emails: ['accounts@example.com'], subject: 'Invoice INV-1', body_html: '<p>Thanks</p>', custom_body: 'Thanks', status: 'sent', reference_number: 'INV-1', idempotency_key: 'EMAIL:INV-1' }
  });
  assert.equal(rec.ok, true);
  assert.equal(rec.shop, 'store-1');
  const dup = await client('client/v1/email', { method: 'POST', apiKey, body: { shop: 'store-1', to_emails: ['rahim@example.com'], subject: 'x', idempotency_key: 'EMAIL:INV-1' } });
  assert.equal(dup.duplicate, true);

  const badEmail = await client('client/v1/email', { method: 'POST', apiKey, body: { shop: 'store-1', to_emails: ['not-an-email'], subject: 'x' } });
  assert.ok(badEmail.error);

  const stats = await device('device/emails/stats?utcOffsetMinutes=360', { token: deviceTokenValue });
  assert.equal(stats.sent, 1);
  assert.equal(stats.latest.subject, 'Invoice INV-1');

  const page = await device('device/emails?page=0', { token: deviceTokenValue });
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0].to_emails, ['rahim@example.com']);
  assert.ok(page.snapshot);

  const detail = await device(`device/emails/${rec.job_id}`, { token: deviceTokenValue });
  assert.equal(detail.body_html, '<p>Thanks</p>');
  assert.deepEqual(detail.cc_emails, ['accounts@example.com']);

  const patched = await client(`client/v1/email/${rec.job_id}`, { method: 'PATCH', apiKey, body: { status: 'failed', error_message: 'provider bounce' } });
  assert.equal(patched.job.status, 'failed');
});

test('releases: publish requires downloadable APK; check-update shape is app-compatible', async () => {
  const notYet = await publicApi('public/releases/check?package=com.connectx.gateway&versionCode=1');
  assert.ok(notYet.error, 'no release yet');

  const draft = await control('control/releases', {
    method: 'POST', token: ownerToken,
    body: { package_name: 'com.connectx.gateway', version: '2.1.0', version_code: 19, release_notes: 'Systems release', published: false }
  });
  assert.equal(draft.release.published, 0);

  const forbidden = await control('control/releases', { method: 'POST', token: operatorToken, body: { package_name: 'com.connectx.gateway', version: '2.1.1', version_code: 20 } });
  assert.match(forbidden.error, /owner/i);

  const backwards = await control('control/releases', { method: 'POST', token: ownerToken, body: { package_name: 'com.connectx.gateway', version: '1.0.0', version_code: 5 } });
  assert.ok(backwards.error);

  const stillNone = await publicApi('public/releases/check?package=com.connectx.gateway&versionCode=1');
  assert.ok(stillNone.error);

  const list = await control('control/releases', { token: ownerToken });
  assert.equal(list.length, 1);
  assert.equal(list[0].version_code, 19);
});

test('settings: global SMS toggle gates the client API', async () => {
  const save = await control('control/settings', { method: 'PATCH', token: operatorToken, body: { sms: { enabled: false } } });
  assert.equal(save.ok, true);
  const blocked = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801766666666', message: 'should be blocked' } });
  assert.match(blocked.error, /disabled/i);

  await control('control/settings', { method: 'PATCH', token: operatorToken, body: { sms: { enabled: true } } });
  const allowed = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801766666666', message: 'allowed again' } });
  assert.equal(allowed.ok, true);
});

test('shop pause blocks its devices; revoke kills the device token', async () => {
  const pause = await control(`control/shops/${shop1.id}`, { method: 'PATCH', token: operatorToken, body: { status: 'paused' } });
  assert.equal(pause.shop.id, shop1.id);
  const blocked = await device('device/stats', { token: deviceTokenValue });
  assert.match(blocked.error, /paused/i);
  const blockedClient = await client('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801766666667', message: 'paused shop' } });
  assert.match(blockedClient.error, /paused/i);

  await control(`control/shops/${shop1.id}`, { method: 'PATCH', token: operatorToken, body: { status: 'active' } });
  const revoke = await control(`control/devices/${deviceId}/revoke`, { method: 'POST', token: operatorToken });
  assert.equal(revoke.ok, true);
  const dead = await device('device/me', { token: deviceTokenValue });
  assert.match(dead.error, /not connected|Pair this phone/i);
});

test('carriers catalog drives the device sim-carrier lookup', async () => {
  const add = await control('control/carriers', {
    method: 'POST', token: operatorToken,
    body: { carrier_name: 'Grameenphone', mcc_mnc: '47001', balance_ussd_code: '*121#', balance_pattern: '(?:Tk|BDT)\\s?([0-9,.]+)' }
  });
  assert.ok(add.carrier.id);
  const badUssd = await control('control/carriers', { method: 'POST', token: operatorToken, body: { carrier_name: 'Bad', balance_ussd_code: 'not-ussd' } });
  assert.ok(badUssd.error);

  const reg = await device('device/register', { method: 'POST', token: adminToken, body: { shopId: shop1.id, deviceName: 'Lookup phone', androidVersion: '14', simCarrier: 'GP', phoneNumber: '+8801744444444' } });
  const found = await device('device/sim-carrier?mccMnc=47001&carrierName=Grameenphone', { token: reg.deviceToken });
  assert.equal(found.supported, true);
  assert.equal(found.carrier.balance_ussd_code, '*121#');
  const missing = await device('device/sim-carrier?mccMnc=99999&carrierName=UnknownTelco', { token: reg.deviceToken });
  assert.equal(missing.supported, false);
});

test('systems management: create custom, delete rules, expired system session', async () => {
  const created = await control('control/systems', {
    method: 'POST', token: ownerToken,
    body: { name: 'DoxTox POS', system_key: 'doxtoxpos', description: 'Custom', api_url: 'https://pos.test' }
  });
  assert.equal(created.system.system_key, 'doxtoxpos');
  const deleted = await control(`control/systems/${created.system.id}`, { method: 'DELETE', token: ownerToken });
  assert.equal(deleted.deleted, true, 'empty system can be deleted');

  const blocked = await control(`control/systems/${emsSystemId}`, { method: 'DELETE', token: ownerToken });
  assert.match(blocked.error, /history|Disable/i, 'system with message history cannot be deleted');

  // expired system token → device/shops asks for re-login
  shopsTokenValid = false;
  const expired = await device('device/shops', { token: adminToken });
  assert.match(expired.error, /sign in again|expired/i);
  shopsTokenValid = true;
  const okAgain = await device('device/shops', { token: adminToken });
  assert.equal(okAgain.shops.length, 3, 'includes the auto-registered store-77');
});

test('dashboard reflects shops/systems', async () => {
  const dash = await control('control/dashboard?utcOffsetMinutes=360', { token: operatorToken });
  assert.ok(dash.systems.total >= 4);
  assert.equal(dash.systems.connected, 1, 'only EMS has an API URL');
  assert.ok(dash.shops.total >= 3);
  assert.ok(dash.bySystem.EMS, 'usage grouped by system name');
  assert.ok(dash.recentJobs.every(j => j.shop_name !== undefined));
});

test('activity log captured key events', async () => {
  const act = await control('control/activity?limit=200', { token: operatorToken });
  const actions = act.items.map(i => i.action);
  assert.ok(actions.includes('platform initialized'));
  assert.ok(actions.some(a => a.includes('administrator sign-in')));
  assert.ok(actions.some(a => a.includes('pairing code')));
  assert.ok(actions.some(a => a.includes('revoke')));
});

test('unknown endpoints 404 cleanly', async () => {
  const c = await control('control/nonexistent', { token: ownerToken });
  assert.match(c.error, /Unknown/);
  const d = await device('device/nonexistent', { token: 'cxd_bogus' });
  assert.ok(d.error);
});
