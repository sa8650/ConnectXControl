/* Email-gateway tests: owner email settings (Brevo & co.), the client
   send endpoint (POST client/v1/email/send) with MOCK_EMAIL + shop scoping, key masking,
   limits, and the EMS-style camelCase aliases + duplicate guard for SMS. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeRequest, makeCtx, readJson } from './helpers/fakeD1.js';
import { controlRoutes } from '../functions/_lib/control.js';
import { clientRoutes } from '../functions/_lib/client.js';

const { env, sqlite } = makeEnv();
env.MOCK_EMAIL = '1'; // provider calls are simulated; no network in tests

const control = async (path, opts = {}) =>
  readJson(await controlRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));
const client = async (path, opts = {}) =>
  readJson(await clientRoutes(makeCtx(env, makeRequest('/api/' + path, opts))));

let ownerToken = '', apiKey = '';

test('bootstrap owner', async () => {
  const res = await control('control/setup', {
    method: 'POST',
    body: { name: 'Owner', email: 'owner@email.test', password: 'super-secret-123' }
  });
  assert.ok(res.token);
  ownerToken = res.token;
});

test('email settings: defaults, owner-only, test blocked before config', async () => {
  const cfg = await control('control/email', { token: ownerToken });
  assert.equal(cfg.provider, 'brevo');
  assert.equal(cfg.api_key_set, false);
  assert.ok(cfg.providers.some(p => p.id === 'brevo'));

  // operator accounts must not see or change email settings
  await control('control/operators', {
    method: 'POST', token: ownerToken,
    body: { name: 'Op', email: 'op@email.test', password: 'operator-secret-1', role: 'operator' }
  });
  const opLogin = await control('control/auth/login', {
    method: 'POST', body: { email: 'op@email.test', password: 'operator-secret-1' }
  });
  const forbidden = await control('control/email', { token: opLogin.token });
  assert.equal(forbidden.error, 'Only the owner can manage email sending.');

  const earlyTest = await control('control/email/test', { method: 'POST', token: ownerToken, body: { to: 'me@email.test' } });
  assert.ok(earlyTest.error, 'test send must fail before From Email + key are set');
});

test('owner saves provider config; api key is masked everywhere', async () => {
  const saved = await control('control/email', {
    method: 'PATCH', token: ownerToken,
    body: { provider: 'brevo', api_key: 'xkb-secret-value', from_name: 'ConnectX HQ', from_email: 'no-reply@connectx.test', reply_to: 'support@connectx.test', enabled: true, daily_limit: 0 }
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.api_key_set, true);
  assert.equal(saved.key_source, 'database');

  const cfg = await control('control/email', { token: ownerToken });
  assert.equal(cfg.from_email, 'no-reply@connectx.test');
  assert.ok(!JSON.stringify(cfg).includes('xkb-secret-value'), 'GET must never return the key');

  const settings = await control('control/settings', { token: ownerToken });
  assert.ok(!JSON.stringify(settings).includes('xkb-secret-value'), 'generic settings must never leak the key');
  assert.equal(settings.email, undefined, 'email config is served only via control/email');

  const badProvider = await control('control/email', { method: 'PATCH', token: ownerToken, body: { provider: 'gmail-smtp' } });
  assert.ok(badProvider.error, 'unknown provider rejected');
  const badFrom = await control('control/email', { method: 'PATCH', token: ownerToken, body: { from_email: 'not-an-email' } });
  assert.ok(badFrom.error, 'invalid from_email rejected');

  // blank api_key keeps the stored one
  const keep = await control('control/email', { method: 'PATCH', token: ownerToken, body: { api_key: '', from_name: 'ConnectX HQ 2' } });
  assert.equal(keep.api_key_set, true);
});

test('test send works through the mock provider', async () => {
  const res = await control('control/email/test', { method: 'POST', token: ownerToken, body: { to: 'me@email.test' } });
  assert.equal(res.ok, true);
  assert.ok(res.mocked);
  const bad = await control('control/email/test', { method: 'POST', token: ownerToken, body: { to: 'nope' } });
  assert.ok(bad.error);
});

test('client key: send email via ConnectX (validation → success → history)', async () => {
  const systems = await control('control/systems', { token: ownerToken });
  const ems = systems.find(c => c.system_key === 'ems');
  const keyRes = await control(`control/systems/${ems.id}/keys`, {
    method: 'POST', token: ownerToken,
    body: { label: 'EMS prod', daily_limit: 50 }
  });
  apiKey = keyRes.api_key;

  const noTo = await client('client/v1/email/send', { method: 'POST', apiKey, body: { subject: 'Hi' } });
  assert.ok(noTo.error, 'missing recipient rejected');
  const noSubject = await client('client/v1/email/send', { method: 'POST', apiKey, body: { to: 'a@b.test' } });
  assert.ok(noSubject.error, 'missing subject rejected');
  const noBody = await client('client/v1/email/send', { method: 'POST', apiKey, body: { to: 'a@b.test', subject: 'Hi' } });
  assert.ok(noBody.error, 'missing body rejected');

  const sent = await client('client/v1/email/send', {
    method: 'POST', apiKey,
    body: {
      shop: 'store-1',
      to: 'customer@shop.test', cc: ['accounts@shop.test'], subject: 'Invoice INV-9 from Main',
      body: 'Dear customer,\nThanks for your purchase.',
      recipient_name: 'Rahim', reference_number: 'INV-9', idempotency_key: 'EMAIL:INV-9'
    }
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 'sent');
  assert.ok(sent.provider_message_id.startsWith('mock-'));
  assert.equal(sent.message, '✓ Email sent via ConnectX');
  assert.ok(sent.id && sent.id === sent.job_id);

  const row = sqlite.prepare('SELECT * FROM cx_jobs WHERE id = ?').get(sent.id);
  assert.equal(row.channel, 'email');
  assert.equal(row.status, 'sent');
  assert.ok(row.body_html.includes('Dear customer'), 'plain body is wrapped into html');
  assert.ok(!row.body_html.includes('<script'), 'body text is escaped');
  assert.deepEqual(JSON.parse(row.cc_emails), ['accounts@shop.test']);

  // idempotent retry returns the original job without resending
  const dup = await client('client/v1/email/send', {
    method: 'POST', apiKey,
    body: { shop: 'store-1', to: 'customer@shop.test', subject: 'Invoice INV-9 from Main', body: 'x', idempotency_key: 'EMAIL:INV-9' }
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.id, sent.id);

  // visible through the email history listing
  const list = await client('client/v1/email?shop=store-1', { apiKey });
  assert.ok(list.items.some(e => e.id === sent.id));
});

test('html emails, camelCase aliases and per-message sender name', async () => {
  const sent = await client('client/v1/email/send', {
    method: 'POST', apiKey,
    body: {
      shop: 'store-1',
      to: 'buyer@shop.test', subject: 'HTML mail',
      html: '<p>Hello <b>world</b></p>',
      fromName: 'Main Shop', replyTo: 'sales@shop.test', referenceNumber: 'INV-10'
    }
  });
  assert.equal(sent.status, 'sent');
  const row = sqlite.prepare('SELECT body_html FROM cx_jobs WHERE id = ?').get(sent.id);
  assert.equal(row.body_html, '<p>Hello <b>world</b></p>');
});

test('global daily email limit + disabled switch', async () => {
  await control('control/email', { method: 'PATCH', token: ownerToken, body: { daily_limit: 2 } });
  const blocked = await client('client/v1/email/send', {
    method: 'POST', apiKey, body: { shop: 'store-1', to: 'x@y.test', subject: 'over limit', body: 'x' }
  });
  assert.match(blocked.error, /daily email limit/i);

  await control('control/email', { method: 'PATCH', token: ownerToken, body: { daily_limit: 0, enabled: false } });
  const off = await client('client/v1/email/send', {
    method: 'POST', apiKey, body: { shop: 'store-1', to: 'x@y.test', subject: 'while disabled', body: 'x' }
  });
  assert.match(off.error, /disabled/i);
  await control('control/email', { method: 'PATCH', token: ownerToken, body: { enabled: true } });
});

test('EMS-style SMS aliases: /sms/send path + camelCase fields + response shape', async () => {
  const sent = await client('client/v1/sms/send', {
    method: 'POST', apiKey,
    body: { storeId: 'store-1', toPhone: '+8801711112222', messageBody: 'Thanks for your purchase!', recipientName: 'Karim', messageType: 'SALE', invoiceNumber: 'INV-77', idempotencyKey: 'SALE:INV-77' }
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.status, 'queued');
  assert.equal(sent.message, '✓ SMS queued for ConnectX');
  assert.ok(sent.id && sent.id === sent.job_id);
  const row = sqlite.prepare('SELECT * FROM cx_jobs WHERE id = ?').get(sent.id);
  assert.equal(row.to_phone, '+8801711112222');
  assert.equal(row.recipient_name, 'Karim');
  assert.equal(row.reference_number, 'INV-77');

  const dup = await client('client/v1/sms/send', {
    method: 'POST', apiKey,
    body: { storeId: 'store-1', toPhone: '+8801711112222', messageBody: 'Thanks for your purchase!', idempotencyKey: 'SALE:INV-77' }
  });
  assert.equal(dup.duplicate, true);
});

test('5-second duplicate guard blocks an accidental immediate resend', async () => {
  const again = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { shop: 'store-1', to: '+8801711112222', message: 'Different body, same phone, instantly' }
  });
  assert.match(again.error, /Duplicate SMS detected/);

  // after the window passes the same destination is allowed again
  sqlite.prepare("UPDATE cx_jobs SET created_at = '2020-01-01T00:00:00.000Z' WHERE to_phone = '+8801711112222'").run();
  const later = await client('client/v1/sms', {
    method: 'POST', apiKey,
    body: { shop: 'store-1', to: '+8801711112222', message: 'Later resend is fine' }
  });
  assert.equal(later.ok, true);
});
