/* Outbound webhook tests: signed shop-scoped payloads + SSRF guards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeEnv } from './helpers/fakeD1.js';
import { dispatchWebhook } from '../functions/_lib/webhook.js';

const { env, sqlite } = makeEnv();
env.WEBHOOK_SIGNING_SECRET = 'whsec-test';

sqlite.prepare(`INSERT INTO cx_systems
  (id, system_key, name, description, api_url, webhook_url, status, created_at, updated_at)
  VALUES ('sys-1','ems','EMS','','https://ems.test','https://demo.test/hook','active','','')`).run();
sqlite.prepare(`INSERT INTO cx_shops
  (id, system_id, external_id, name, shop_code, status, created_at, updated_at)
  VALUES ('shop-1','sys-1','store-42','Dhaka Main','DHK-1','active','','')`).run();

const job = {
  id: 'job-1', system_id: 'sys-1', shop_id: 'shop-1', channel: 'sms', status: 'sent',
  to_phone: '+8801712345678', recipient_name: 'Rahim', message_type: 'SALE', event_type: null,
  reference_id: 'ref-1', reference_number: 'INV-9', error_message: null,
  sent_at: '2026-09-27T10:00:00.000Z'
};

let captured = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 200 }; };

test('dispatchWebhook posts an HMAC-signed, shop-scoped payload', async () => {
  await dispatchWebhook(env, job, 'job.sent');
  assert.ok(captured, 'fetch was called');
  assert.equal(captured.url, 'https://demo.test/hook');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers['x-connectx-event'], 'job.sent');
  assert.equal(captured.opts.headers['content-type'], 'application/json');
  assert.equal(captured.opts.headers['user-agent'], 'ConnectX-Webhook/1.0');

  const body = JSON.parse(captured.opts.body);
  assert.equal(body.event, 'job.sent');
  assert.equal(body.system_key, 'ems');
  assert.equal(body.job.id, 'job-1');
  assert.equal(body.job.status, 'sent');
  assert.equal(body.job.shop_id, 'shop-1');
  assert.equal(body.job.shop_external_id, 'store-42', 'the system can map back to its own shop');
  assert.equal(body.job.shop_name, 'Dhaka Main');
  assert.equal(body.job.to_phone, '+8801712345678');
  assert.equal(body.job.reference_id, 'ref-1');
  assert.equal(body.job.reference_number, 'INV-9');
  assert.ok(body.sent_at, 'delivery timestamp present');

  const expected = 'sha256=' + createHmac('sha256', 'whsec-test')
    .update(captured.opts.body).digest('hex');
  assert.equal(captured.opts.headers['x-connectx-signature'], expected, 'HMAC over the raw body');
});

test('unsigned mode omits the signature header', async () => {
  captured = null;
  delete env.WEBHOOK_SIGNING_SECRET;
  await dispatchWebhook(env, { ...job, status: 'failed', error_message: 'RADIO_OFF' }, 'job.failed');
  assert.ok(captured);
  assert.equal(captured.opts.headers['x-connectx-signature'], undefined);
  assert.equal(JSON.parse(captured.opts.body).job.error_message, 'RADIO_OFF');
  env.WEBHOOK_SIGNING_SECRET = 'whsec-test';
});

test('SSRF guards: http, loopback and private ranges are never called', async () => {
  for (const bad of ['http://demo.test/hook', 'https://127.0.0.1/hook', 'https://localhost/hook',
                     'https://10.1.2.3/hook', 'https://192.168.1.1/hook', 'not-a-url']) {
    captured = null;
    sqlite.prepare('UPDATE cx_systems SET webhook_url = ?').run(bad);
    await dispatchWebhook(env, job, 'job.sent');
    assert.equal(captured, null, `blocked: ${bad}`);
  }
});

test('no webhook configured / unknown system → silent no-op', async () => {
  captured = null;
  sqlite.prepare('UPDATE cx_systems SET webhook_url = NULL').run();
  await dispatchWebhook(env, job, 'job.sent');
  assert.equal(captured, null);
  await dispatchWebhook(env, { id: 'x', status: 'sent' }, 'job.sent'); // no system_id
  assert.equal(captured, null);
  globalThis.fetch = realFetch;
});
