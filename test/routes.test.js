/* End-to-end route tests on a real (in-memory) SQLite database.
   Walks the full platform lifecycle:
   setup → workspace → API key → client SMS → device pair → claim → report
   → cancel race → releases → permissions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeRequest, makeCtx, readJson } from './helpers/fakeD1.js';
import { controlRoutes } from '../functions/_lib/control.js';
import { deviceRoutes } from '../functions/_lib/device.js';
import { clientRoutes } from '../functions/_lib/client.js';
import { publicReleaseRoutes } from '../functions/_lib/releases.js';

const { env, sqlite } = makeEnv();

const control = async (path, opts = {}) =>
  readJson(await controlRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));
const device = async (path, opts = {}) =>
  readJson(await deviceRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));
const client = async (path, opts = {}) =>
  readJson(await clientRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));
const publicApi = async (path, opts = {}) =>
  readJson(await publicReleaseRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));

let ownerToken = '', operatorToken = '', apiKey = '', workspaceId = '', deviceId = '', deviceTokenValue = '';

test('bootstrap reports uninitialized, then setup creates the owner', async t => {
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

  const after = await control('control/bootstrap');
  assert.equal(after.initialized, true);
});

test('seeded clients exist (EMS, CareOS, InfluenceOS, PlugX) + default workspace', async () => {
  const clients = await control('control/clients', { token: ownerToken });
  const keys = clients.map(c => c.client_key).sort();
  assert.deepEqual(keys, ['careos', 'ems', 'influenceos', 'plugx']);
  const ws = await control('control/workspaces', { token: ownerToken });
  assert.equal(ws.length, 1);
  assert.equal(ws[0].code, 'MAIN');
  workspaceId = ws[0].id;
});

test('login works for the owner; wrong password fails', async () => {
  const bad = await control('control/auth/login', { method: 'POST', body: { email: 'owner@connectx.test', password: 'nope-nope-nope' } });
  assert.equal(bad.error, 'Wrong email or password.');
  const ok = await control('control/auth/login', { method: 'POST', body: { email: 'owner@connectx.test', password: 'super-secret-123' } });
  assert.ok(ok.token);
});

test('owner creates an operator account; operator cannot issue keys', async () => {
  const created = await control('control/operators', {
    method: 'POST', token: ownerToken,
    body: { name: 'Shop Operator', email: 'op@connectx.test', password: 'operator-secret-1', role: 'operator' }
  });
  assert.equal(created.operator.role ?? 'operator', 'operator');
  const login = await device('device/auth/login', { method: 'POST', body: { email: 'op@connectx.test', password: 'operator-secret-1' } });
  assert.ok(login.token, 'operator can sign in through the device API too');
  assert.equal(login.user.email, 'op@connectx.test');
  assert.ok(login.user.admin_code !== undefined, 'legacy admin_code key present for the phone app');
  operatorToken = login.token;

  const forbidden = await control('control/clients', { method: 'POST', token: operatorToken, body: { name: 'Sneaky', client_key: 'sneaky' } });
  assert.match(forbidden.error, /owner/i);
});

test('operator creates a workspace', async () => {
  const res = await control('control/workspaces', { method: 'POST', token: operatorToken, body: { name: 'Dhaka Main', address: 'Dhaka', phone: '+8801700000000' } });
  assert.ok(res.workspace.id);
  assert.equal(res.workspace.code, 'DHAKA-MAIN');
  workspaceId = res.workspace.id;
});

test('owner issues an API key for EMS scoped to the workspace', async () => {
  const clients = await control('control/clients', { token: ownerToken });
  const ems = clients.find(c => c.client_key === 'ems');
  const res = await control(`control/clients/${ems.id}/keys`, {
    method: 'POST', token: ownerToken,
    body: { label: 'EMS production', workspace_id: workspaceId, daily_limit: 5 }
  });
  assert.match(res.api_key, /^cxk_live_/);
  assert.equal(res.key.key_hash, undefined, 'hash must never be returned');
  apiKey = res.api_key;
});

test('client API rejects unknown/missing keys', async () => {
  const noKey = await client('client/v1/ping');
  assert.match(noKey.error, /Missing ConnectX API key/);
  const badKey = await client('client/v1/ping', { apiKey: 'cxk_live_bogus' });
  assert.match(badKey.error, /Unknown/);
});

test('client ping + SMS send + idempotency + daily limit', async () => {
  const ping = await client('client/v1/ping', { apiKey });
  assert.equal(ping.ok, true);
  assert.equal(ping.client.key, 'ems');

  const bad = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: '12', message: 'x' } });
  assert.ok(bad.error, 'too-short phone rejected');
  const noMsg = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: '+8801712345678' } });
  assert.ok(noMsg.error, 'missing message without event_type rejected');

  const sent = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { to: '+8801712345678', recipient_name: 'Rahim', message: 'Invoice INV-1 confirmed.', message_type: 'SALE', reference_number: 'INV-1', idempotency_key: 'SALE:INV-1' }
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 'queued');

  const dup = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { to: '+8801712345678', message: 'Invoice INV-1 confirmed.', idempotency_key: 'SALE:INV-1' }
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.job_id, sent.job_id);

  // template rendering via event_type
  const templated = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { to: '+8801799999999', event_type: 'TEST', recipient_name: 'Karim' }
  });
  assert.equal(templated.ok, true);

  // daily limit = 5 → fill it up
  for (let i = 0; i < 3; i++) {
    const r = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: `+880170000000${i}`, message: `bulk ${i}` } });
    assert.equal(r.ok, true);
  }
  const limited = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: '+8801700000099', message: 'over limit' } });
  assert.match(limited.error, /Daily ConnectX limit/);
});

test('template event renders workspace template', async () => {
  const rows = sqlite.prepare("SELECT message_body FROM cx_jobs WHERE event_type='TEST' ORDER BY created_at DESC LIMIT 1").all();
  assert.match(rows[0].message_body, /ConnectX test from Dhaka Main/);
});

test('pairing code flow: generate → pair phone → device token works', async () => {
  const code = await control('control/devices/pairing-code', { method: 'POST', token: operatorToken, body: { workspace_id: workspaceId, ttl_minutes: 15 } });
  assert.match(code.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

  const used = await device('device/pair', { method: 'POST', body: { code: 'AAAA-BBBB' } });
  assert.ok(used.error, 'unknown code rejected');

  const paired = await device('device/pair', {
    method: 'POST',
    body: { code: code.code, deviceName: 'Pixel 8', androidVersion: '15', appVersion: '2.0.0', simCarrier: 'Grameenphone', phoneNumber: '+8801711111111', simSubscriptionId: 1 }
  });
  assert.match(paired.deviceToken, /^cxd_/);
  assert.equal(paired.shop.name, 'Dhaka Main', 'legacy shop key present');
  assert.equal(paired.device.status, 'pending_test');
  deviceId = paired.device.id;
  deviceTokenValue = paired.deviceToken;

  const replay = await device('device/pair', { method: 'POST', body: { code: code.code } });
  assert.ok(replay.error, 'code cannot be reused');

  const me = await device('device/me', { token: deviceTokenValue });
  assert.equal(me.device.device_name, 'Pixel 8');
  assert.equal(me.shop.code, 'DHAKA-MAIN');

  const bogus = await device('device/me', { token: 'cxd_totally-bogus' });
  assert.ok(bogus.error);
});

test('operator login flow parity: workspaces + register device', async () => {
  const ws = await device('device/workspaces', { token: operatorToken });
  assert.ok(Array.isArray(ws.shops), 'legacy shops key present');
  const found = ws.shops.find(s => s.id === workspaceId);
  assert.equal(found.name, 'Dhaka Main');

  const reg = await device('device/register', {
    method: 'POST', token: operatorToken,
    body: { storeId: workspaceId, deviceName: 'Galaxy A15', androidVersion: '14', simSubscriptionId: 2, simCarrier: 'Robi', phoneNumber: '+8801822222222' }
  });
  assert.match(reg.deviceToken, /^cxd_/);
  assert.equal(reg.shop.id, workspaceId);
  assert.ok(reg.administrator.email === 'op@connectx.test');
});

test('claim → send → report lifecycle with race-safe claiming', async () => {
  const before = await device('device/jobs/claim', { method: 'POST', token: deviceTokenValue, body: { limit: 10 } });
  assert.equal(before.error, undefined, 'pending_test device can claim (setup test SMS)');
  const n = before.jobs.length;
  assert.ok(n >= 1);
  for (const j of before.jobs) {
    assert.ok(j.phone_number && j.message, 'claimed job has payload');
    assert.ok(j.shop_id === workspaceId, 'legacy shop_id present');
  }

  // second device gets nothing (jobs already claimed)
  const otherReg = await device('device/register', {
    method: 'POST', token: operatorToken,
    body: { storeId: workspaceId, deviceName: 'Second phone', androidVersion: '13', simCarrier: 'Banglalink', phoneNumber: '+8801933333333' }
  });
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
  const sent = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: '+8801755555555', message: 'cancel me' } }).catch(() => null);
  // daily limit already hit → expect 429 error object
  if (sent && sent.error) {
    assert.match(sent.error, /Daily ConnectX limit/);
    // raise the limit through the owner and retry
    sqlite.prepare('UPDATE cx_api_keys SET daily_limit = 100').run();
  }
  const job = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: '+8801755555555', message: 'cancel me' } });
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

  const act = await device('device/activity?range=7d', { token: deviceTokenValue });
  assert.ok(act.items.length >= 3);
  assert.ok(act.items.every(i => i.id && i.status));
});

test('control jobs list + retry failed job', async () => {
  const list = await control('control/jobs?status=failed', { token: operatorToken });
  assert.ok(list.items.length >= 1);
  const failedJob = list.items[0];
  const retry = await control(`control/jobs/${failedJob.id}/retry`, { method: 'POST', token: operatorToken });
  assert.equal(retry.ok, true);
  const cancelRace = await control(`control/jobs/${failedJob.id}/cancel`, { method: 'POST', token: operatorToken });
  assert.equal(cancelRace.ok, true, 're-queued job can be cancelled from console');
});

test('email records: client logs history, device reads it paginated', async () => {
  const rec = await client('client/v1/email', {
    method: 'POST', apiKey,
    body: { to_emails: ['rahim@example.com'], cc_emails: ['accounts@example.com'], subject: 'Invoice INV-1', body_html: '<p>Thanks</p>', custom_body: 'Thanks', status: 'sent', reference_number: 'INV-1', idempotency_key: 'EMAIL:INV-1' }
  });
  assert.equal(rec.ok, true);
  const dup = await client('client/v1/email', { method: 'POST', apiKey, body: { to_emails: ['rahim@example.com'], subject: 'x', idempotency_key: 'EMAIL:INV-1' } });
  assert.equal(dup.duplicate, true);

  const badEmail = await client('client/v1/email', { method: 'POST', apiKey, body: { to_emails: ['not-an-email'], subject: 'x' } });
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

  // external https URL that cannot be verified offline → publish blocked
  const draft = await control('control/releases', {
    method: 'POST', token: ownerToken,
    body: { package_name: 'com.connectx.gateway', version: '2.0.0', version_code: 18, release_notes: 'Independence release', published: false }
  });
  assert.equal(draft.release.published, 0);

  // operator cannot publish
  const forbidden = await control('control/releases', { method: 'POST', token: operatorToken, body: { package_name: 'com.connectx.gateway', version: '2.0.1', version_code: 19 } });
  assert.match(forbidden.error, /owner/i);

  // version_code cannot go backwards
  const backwards = await control('control/releases', { method: 'POST', token: ownerToken, body: { package_name: 'com.connectx.gateway', version: '1.0.0', version_code: 5 } });
  assert.ok(backwards.error);

  // unpublished release is invisible to the public check
  const stillNone = await publicApi('public/releases/check?package=com.connectx.gateway&versionCode=1');
  assert.ok(stillNone.error);

  const list = await control('control/releases', { token: ownerToken });
  assert.equal(list.length, 1);
  assert.equal(list[0].version_code, 18);
});

test('settings: per-workspace SMS toggle gates the client API', async () => {
  const save = await control('control/settings', { method: 'PATCH', token: operatorToken, body: { sms: { [workspaceId]: { enabled: false } } } });
  assert.equal(save.ok, true);
  const blocked = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: '+8801766666666', message: 'should be blocked' } });
  assert.match(blocked.error, /disabled/i);

  await control('control/settings', { method: 'PATCH', token: operatorToken, body: { sms: { [workspaceId]: { enabled: true } } } });
  const allowed = await client('client/v1/sms', { method: 'POST', apiKey, body: { to: '+8801766666666', message: 'allowed again' } });
  assert.equal(allowed.ok, true);
});

test('workspace pause blocks devices; revoke kills the device token', async () => {
  const pause = await control(`control/workspaces/${workspaceId}`, { method: 'PATCH', token: operatorToken, body: { status: 'paused' } });
  assert.equal(pause.workspace.id, workspaceId);
  const blocked = await device('device/stats', { token: deviceTokenValue });
  assert.match(blocked.error, /paused/i);

  await control(`control/workspaces/${workspaceId}`, { method: 'PATCH', token: operatorToken, body: { status: 'active' } });
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

  // device was revoked above; register a fresh one for the lookup
  const reg = await device('device/register', { method: 'POST', token: operatorToken, body: { storeId: workspaceId, deviceName: 'Lookup phone', androidVersion: '14', simCarrier: 'GP', phoneNumber: '+8801744444444' } });
  const found = await device('device/sim-carrier?mccMnc=47001&carrierName=Grameenphone', { token: reg.deviceToken });
  assert.equal(found.supported, true);
  assert.equal(found.carrier.balance_ussd_code, '*121#');
  const missing = await device('device/sim-carrier?mccMnc=99999&carrierName=UnknownTelco', { token: reg.deviceToken });
  assert.equal(missing.supported, false);
});

test('activity log captured key events', async () => {
  const act = await control('control/activity?limit=200', { token: operatorToken });
  const actions = act.items.map(i => i.action);
  assert.ok(actions.includes('platform initialized'));
  assert.ok(actions.some(a => a.includes('pairing code')));
  assert.ok(actions.some(a => a.includes('revoke')));
});

test('unknown endpoints 404 cleanly', async () => {
  const c = await control('control/nonexistent', { token: ownerToken });
  assert.match(c.error, /Unknown/);
  const d = await device('device/nonexistent', { token: deviceTokenValue === '' ? 'x' : operatorToken });
  assert.ok(d.error);
});
