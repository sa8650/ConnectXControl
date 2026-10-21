/*
 * Local ConnectX Control smoke test for the EMS-direct architecture.
 * Start a local Pages Functions stack with the existing D1/R2 bindings first:
 *   npx wrangler pages dev dist --port 8788 --ip 0.0.0.0
 * Then run:
 *   node scripts/e2e.mjs
 *
 * Uses a clean local D1 database for first-run setup. If it is already
 * initialized, set CONTROL_EMAIL and CONTROL_PASSWORD for the existing owner.
 * This script does not send SMS or email and never calls EMS.
 */
const ORIGIN = (process.env.CONTROL_ORIGIN || 'http://127.0.0.1:8788').replace(/\/$/, '');
const BASE = `${ORIGIN}/api`;
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};
async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const email = process.env.CONTROL_EMAIL || 'owner@demo.test';
const password = process.env.CONTROL_PASSWORD || 'demo-secret-123';
let r = await call('control/bootstrap');
ok('Control bootstrap is available', r.status === 200 && typeof r.data.initialized === 'boolean', JSON.stringify(r.data));
let ownerToken = '';
if (r.data.initialized === false) {
  r = await call('control/setup', { method: 'POST', body: { name: 'Owner', email, password } });
  ownerToken = r.data.token || '';
  ok('first-run Control owner setup', r.status === 201 && !!ownerToken, JSON.stringify(r.data));
} else {
  r = await call('control/auth/login', { method: 'POST', body: { email, password } });
  ownerToken = r.data.token || '';
  ok('existing Control owner sign-in', r.status === 200 && !!ownerToken, JSON.stringify(r.data));
}

if (ownerToken) {
  r = await call('control/auth/me', { token: ownerToken });
  ok('owner session remains authenticated', r.status === 200 && !!r.data.operator, JSON.stringify(r.data));

  r = await call('control/email', { token: ownerToken });
  ok('email settings remain available', r.status === 200 && typeof r.data.provider === 'string', JSON.stringify(r.data));
  const originalEmailSettings = r.data;
  r = await call('control/email', { method: 'PATCH', token: ownerToken, body: {
    provider: originalEmailSettings.provider || 'brevo',
    from_name: originalEmailSettings.from_name || 'ConnectX',
    from_email: originalEmailSettings.from_email || 'no-reply@demo.test',
    enabled: Boolean(originalEmailSettings.enabled),
    api_key: ''
  } });
  ok('email-provider settings can be read/updated without exposing secrets',
    r.status === 200 && !Object.hasOwn(r.data, 'api_key'), JSON.stringify(r.data));

  r = await call('control/releases', { token: ownerToken });
  ok('Android release management remains available', r.status === 200 && Array.isArray(r.data), JSON.stringify(r.data).slice(0, 240));

  r = await call('control/activity?limit=10', { token: ownerToken });
  ok('Control audit/activity view remains available', r.status === 200 && Array.isArray(r.data.items || r.data), JSON.stringify(r.data).slice(0, 240));
}

// No historical Control endpoint, pairing, relay, or queue route is allowed
// to accept an SMS write. EMS owns dispatch; the GET monitoring surfaces are
// local D1 views are read-only; Android writes telemetry using its separate token.
for (const [path, method] of [
  ['connect', 'POST'],
  ['device/auth/login', 'POST'],
  ['device/register', 'POST'],
  ['device/pair', 'POST'],
  ['device/jobs/claim', 'POST'],
  ['device/jobs/report', 'POST'],
  ['client/v1/sms', 'POST'],
  ['control/connect/endpoint', 'POST'],
  ['control/connect/request', 'POST'],
  ['control/connect/jobs', 'GET'],
  ['control/phones', 'POST'],
  ['control/devices', 'POST'],
  ['control/devices/pairing-code', 'POST'],
  ['control/jobs', 'POST'],
  ['control/systems', 'GET'],
  ['control/keys', 'GET'],
  ['control/shops', 'GET'],
  ['control/shops', 'POST'],

  ['control/dashboard', 'POST']
]) {
  r = await call(path, { method, token: ownerToken });
  ok(`retired SMS/setup route ${method} /api/${path} returns 410`, r.status === 410, JSON.stringify(r.data));
}
for (const path of ['control/phones', 'control/devices', 'control/jobs', 'control/dashboard']) {
  r = await call(path, { token: ownerToken });
  ok(`read-only Control monitoring route /api/${path} is not retired`, r.status !== 410, JSON.stringify(r.data));
}

// These old app routes are retained only for read-only email history; they
// must reach auth and must never be a hidden SMS transport.
for (const path of ['device/emails', 'device/emails/stats', 'device/emails/email-1']) {
  r = await call(path, { token: '' });
  ok(`legacy ${path} remains email-only and requires authentication`, r.status === 401, JSON.stringify(r.data));
}
for (const [path, method] of [['client/v1/email/send', 'POST'], ['client/v1/email', 'GET']]) {
  r = await call(path, { method });
  ok(`email client API ${path} remains available and requires its API key`, r.status === 401, JSON.stringify(r.data));
}

// Public Control website and its independent APK update boundary stay live.
r = await call('health');
ok('Control API health reports EMS-direct mode', r.status === 200 && r.data.sms_delivery === 'ems-direct', JSON.stringify(r.data));
const page = await fetch(`${ORIGIN}/`);
ok('Control management SPA is served', page.status === 200 && (await page.text()).includes('root'));

console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
