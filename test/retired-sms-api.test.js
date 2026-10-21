import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as apiRequest } from '../functions/api/[[path]].js';
import { onRequest as connectRequest } from '../functions/connect.js';

async function callApi(path, method = 'GET') {
  const request = new Request(`https://control.test/api/${path}`, { method });
  return apiRequest({ request, env: {}, next: async () => new Response('spa') });
}

for (const [path, method] of [
  ['connect', 'POST'],
  ['device/jobs/claim', 'POST'],
  ['device/jobs/report', 'POST'],
  ['device/auth/login', 'POST'],
  ['client/v1/sms', 'POST'],
  ['control/connect/endpoint', 'POST'],
  ['control/connect/request', 'POST'],
  ['control/connect/jobs', 'GET'],
  ['control/phones', 'POST'],
  ['control/devices', 'POST'],
  ['control/devices/pairing-code', 'POST'],
  ['control/devices/device-1/revoke', 'POST'],
  ['control/jobs', 'POST'],
  ['control/jobs/job-1/retry', 'POST'],
  ['control/dashboard', 'POST'],
  ['control/systems', 'POST'],
  ['control/systems/system-1', 'PATCH'],
  ['control/shops', 'GET'],
  ['control/shops', 'POST'],
  ['control/shops/shop-1', 'PATCH'],
  ['control/shops/shop-1', 'DELETE'],
  ['control/keys/key-1/revoke', 'POST']
]) {
  test(`${method} /api/${path} is retired before touching Control DB`, async () => {
    const response = await callApi(path, method);
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.match(body.error, /EMS owns SMS delivery/i);
  });
}

test('read-only Control database monitoring paths pass the retired-dispatch gate', async () => {
  for (const path of ['control/dashboard', 'control/devices', 'control/phones', 'control/jobs']) {
    const response = await callApi(path, 'GET');
    assert.equal(response.status, 503, `${path} should pass the retirement gate and report missing database configuration`);
    assert.notEqual(response.status, 410);
  }
});

test('public /connect relay returns 410', async () => {
  const response = await connectRequest({ request: new Request('https://control.test/connect', { method: 'POST' }) });
  assert.equal(response.status, 410);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.code, 'sms_dispatch_retired');
});

test('email-only legacy client routes remain available behind API-key authentication', async () => {
  for (const [path, method] of [['client/v1/email/send', 'POST'], ['client/v1/email', 'GET'], ['client/v1/email/email-1', 'PATCH']]) {
    const response = await apiRequest({
      request: new Request(`https://control.test/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }),
      env: { DB: {}, SESSION_SECRET: 'test-session-secret' },
      next: async () => new Response('spa')
    });
    assert.equal(response.status, 401, `${path} must reach email client authentication, not 410 SMS retirement`);
    assert.match((await response.json()).error, /API key/i);
  }
});

test('Control email-provider management remains routed and protected', async () => {
  const response = await apiRequest({
    request: new Request('https://control.test/api/control/email', { method: 'GET' }),
    env: { DB: {}, SESSION_SECRET: 'test-session-secret' },
    next: async () => new Response('spa')
  });
  assert.equal(response.status, 401);
  assert.notEqual(response.status, 410);
});

test('legacy phone email-history routes remain available (authentication is still required)', async () => {
  for (const path of ['device/emails', 'device/emails/stats', 'device/emails/email-1']) {
    const response = await apiRequest({
      request: new Request(`https://control.test/api/${path}`, { method: 'GET' }),
      env: { DB: {}, SESSION_SECRET: 'test-session-secret' },
      next: async () => new Response('spa')
    });
    assert.equal(response.status, 401, `${path} should reach phone email-history auth, not the 410 retirement handler`);
    const body = await response.json();
    assert.match(body.error, /Sign in again/i);
  }
});

test('OPTIONS remains available for CORS preflight', async () => {
  const response = await apiRequest({
    request: new Request('https://control.test/api/device/jobs/claim', { method: 'OPTIONS' }),
    env: {}
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});
