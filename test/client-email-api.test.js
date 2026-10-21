import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequest as apiRequest } from '../functions/api/[[path]].js';
import { sha256 } from '../functions/_lib/core.js';
import { createFakeD1 } from '../test-support/fakeD1.js';

const schemaSql = readFileSync(new URL('../schema/connectx_schema.sql', import.meta.url), 'utf8');
const apiKey = 'cxk_live_email_compatibility_test';

async function call(env, path, method, body) {
  const request = new Request(`https://control.test/api/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-connectx-key': apiKey
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return apiRequest({ request, env, next: async () => new Response('spa') });
}

test('authenticated provider-email send, idempotency, and history remain available', async t => {
  const fake = createFakeD1(schemaSql);
  t.after(() => fake.close());
  const { sqlite, DB } = fake;
  const now = new Date().toISOString();
  const systemId = 'ems-system';
  const keyId = 'email-api-key';

  sqlite.prepare(`INSERT INTO cx_systems (id, system_key, name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(systemId, 'ems', 'EMS', now, now);
  sqlite.prepare(`INSERT INTO cx_api_keys (id, system_id, label, key_prefix, key_hash, daily_limit, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(
    keyId, systemId, 'email compatibility test', apiKey.slice(0, 13), await sha256(apiKey), 100, now
  );
  sqlite.prepare('INSERT INTO cx_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)').run(
    'email', JSON.stringify({ provider: 'brevo', api_key: 'test-only-key', from_email: 'mailer@example.com', from_name: 'EMS', enabled: true }), now
  );

  const env = { DB, SESSION_SECRET: 'test-session-secret', MOCK_EMAIL: '1' };
  const message = {
    shop: 'ems-shop-1',
    to: ['customer@example.com'],
    subject: 'Payment received',
    text: 'Thank you for your payment.',
    idempotencyKey: 'payment-123-email'
  };

  const sentResponse = await call(env, 'client/v1/email/send', 'POST', message);
  assert.equal(sentResponse.status, 201);
  const sent = await sentResponse.json();
  assert.equal(sent.status, 'sent');
  assert.equal(sent.shop, 'ems-shop-1');
  assert.ok(sent.id);

  const stored = sqlite.prepare('SELECT * FROM cx_jobs WHERE id = ?').get(sent.id);
  assert.equal(stored.channel, 'email');
  assert.equal(stored.status, 'sent');
  assert.equal(stored.provider_message_id.startsWith('mock-msg-'), true);
  assert.equal(JSON.parse(stored.to_emails)[0], 'customer@example.com');

  const duplicateResponse = await call(env, 'client/v1/email/send', 'POST', message);
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).duplicate, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM cx_jobs WHERE channel = 'email'").get().count, 1);

  const historyResponse = await call(env, 'client/v1/email', 'GET');
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.equal(history.count, 1);
  assert.equal(history.items[0].id, sent.id);
  assert.equal(history.items[0].status, 'sent');
  assert.equal(history.items[0].to_emails[0], 'customer@example.com');

  const patchResponse = await call(env, `client/v1/email/${sent.id}`, 'PATCH', {
    status: 'sent', provider_message_id: 'provider-delivery-reference'
  });
  assert.equal(patchResponse.status, 200);
  assert.equal(sqlite.prepare('SELECT provider_message_id FROM cx_jobs WHERE id = ?').get(sent.id).provider_message_id,
    'provider-delivery-reference');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM cx_jobs WHERE channel = 'sms'").get().count, 0);
});
