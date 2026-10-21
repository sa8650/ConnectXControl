import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequest } from '../functions/api/[[path]].js';
import { signToken } from '../functions/_lib/core.js';
import { createFakeD1 } from '../test-support/fakeD1.js';

const schema = readFileSync(new URL('../schema/connectx_schema.sql', import.meta.url), 'utf8');
const ownerId = 'telemetry-owner-test';
const emsDeviceId = '11111111-1111-4111-8111-111111111111';

async function fixture() {
  const fake = createFakeD1(schema);
  const now = new Date().toISOString();
  fake.sqlite.prepare(`INSERT INTO cx_operators(id,name,email,password_hash,role,active,created_at,updated_at)
    VALUES(?,?,?,'test','owner',1,?,?)`).run(ownerId, 'Control Owner', 'owner@example.test', now, now);
  const env = { DB: fake.DB, SESSION_SECRET: 'test-session-secret-for-control-telemetry' };
  const ownerToken = await signToken({ id: ownerId, role: 'owner', exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  const call = (path, method = 'GET', body = {}, token = '') => onRequest({
    env,
    request: new Request(`https://control.example.test/api/${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    }),
    next: async () => new Response('spa')
  });
  return { fake, ownerToken, call };
}

test('Android registration automatically creates a separate Control token and mirrors EMS device/SIM details', async t => {
  const f = await fixture();
  t.after(() => f.fake.close());
  const registration = {
    emsDeviceId, adminId: 'ems-admin-44', adminCode: 'A-44', adminName: 'Test Admin', adminEmail: 'admin@example.test',
    shopId: 'shop-1', shopName: 'Jessore Store', deviceName: 'Pixel', simSubscriptionId: '4',
    simCarrier: 'Grameenphone', phoneNumber: '+8801712345678', deviceStatus: 'active',
    androidVersion: '15', appVersion: '2.2.0', versionCode: 22
  };
  const registered = await f.call('telemetry/register', 'POST', registration);
  assert.equal(registered.status, 201);
  const credentials = await registered.json();
  assert.equal(credentials.deviceId, emsDeviceId);
  assert.match(credentials.token, /^cxm_/);

  const heartbeat = await f.call('telemetry/heartbeat', 'POST', registration, credentials.token);
  assert.equal(heartbeat.status, 200);

  const send = await f.call('telemetry/sms', 'POST', {
    jobId: 'ems-job-1', shopId: 'shop-1', shopName: 'Jessore Store', recipientPhone: '+8801812345678',
    recipientName: 'Recipient', messageType: 'SALE', status: 'sent', createdAt: '2026-10-21T09:00:00.000Z', sentAt: '2026-10-21T09:01:00.000Z'
  }, credentials.token);
  assert.equal(send.status, 200);
  await f.call('telemetry/sms', 'POST', {
    jobId: 'ems-job-1', shopId: 'shop-1', shopName: 'Jessore Store', recipientPhone: '+8801812345678',
    recipientName: 'Recipient', messageType: 'SALE', status: 'delivered', createdAt: '2026-10-21T09:00:00.000Z', sentAt: '2026-10-21T09:01:00.000Z', deliveredAt: '2026-10-21T09:02:00.000Z'
  }, credentials.token);
  const stale = await f.call('telemetry/sms', 'POST', {
    jobId: 'ems-job-1', shopId: 'shop-1', recipientPhone: '+8801812345678', status: 'sent', resultAt: '2026-10-21T09:01:00.000Z'
  }, credentials.token);
  assert.equal((await stale.json()).status, 'delivered', 'late retries do not downgrade delivered status');

  const dashboard = await f.call('control/dashboard', 'GET', {}, f.ownerToken);
  assert.equal(dashboard.status, 200);
  const data = await dashboard.json();
  assert.deepEqual(data.users, { active: 1, registered: 1 });
  assert.equal(data.devices.online, 1);
  assert.equal(data.sms.delivered, 1);
  assert.equal(data.sms.total, 1);

  const devices = await f.call('control/devices', 'GET', {}, f.ownerToken);
  const deviceData = await devices.json();
  assert.equal(deviceData.items[0].shopName, 'Jessore Store');
  assert.equal(deviceData.items[0].administratorName, 'Test Admin');
  assert.equal(deviceData.items[0].simCarrier, 'Grameenphone');
  assert.equal(deviceData.items[0].phoneNumber, '+8801712345678');
  assert.equal(deviceData.items[0].appVersion, '2.2.0');

  const history = await f.call('control/jobs?range=all', 'GET', {}, f.ownerToken);
  const historyData = await history.json();
  assert.equal(historyData.items[0].recipientPhone, '+8801812345678');
  assert.equal(historyData.items[0].status, 'delivered');
});

test('device registration validates identifiers, owner code enrollment is retired, and owner can revoke/restore', async t => {
  const f = await fixture();
  t.after(() => f.fake.close());
  assert.equal((await f.call('telemetry/register', 'POST', { emsDeviceId: 'not-a-uuid', adminId: 'a', shopId: 's' })).status, 400);
  assert.equal((await f.call('control/monitor/enrollment', 'POST', {}, f.ownerToken)).status, 410);
  assert.equal((await f.call('telemetry/enroll', 'POST', { code: '12345678', adminId: 'a' })).status, 410);

  const registered = await f.call('telemetry/register', 'POST', {
    emsDeviceId, adminId: 'admin-1', shopId: 'shop-1', shopName: 'One', deviceName: 'Pixel', deviceStatus: 'active'
  });
  const credentials = await registered.json();
  const invalidHeartbeat = await f.call('telemetry/heartbeat', 'POST', {
    emsDeviceId: '22222222-2222-4222-8222-222222222222', adminId: 'admin-1', shopId: 'shop-1'
  }, credentials.token);
  assert.equal(invalidHeartbeat.status, 401);

  assert.equal((await f.call(`control/monitor/devices/${emsDeviceId}/revoke`, 'POST', {}, f.ownerToken)).status, 200);
  assert.equal((await f.call('telemetry/heartbeat', 'POST', {
    emsDeviceId, adminId: 'admin-1', shopId: 'shop-1'
  }, credentials.token)).status, 401);
  assert.equal((await f.call(`control/monitor/devices/${emsDeviceId}/restore`, 'POST', {}, f.ownerToken)).status, 200);
});
