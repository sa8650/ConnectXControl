/* End-to-end smoke test against a live local stack:
     ConnectX control  http://127.0.0.1:8788  (wrangler pages dev)
     Mock EMS system   http://127.0.0.1:8799  (scripts/mock-ems.mjs)
   Walks: setup → configure EMS → federated phone login → shop sync →
   device register → API key → client SMS → claim/report → pairing code →
   email send (mock) → dashboard.  Run: node scripts/e2e.mjs */
const BASE = 'http://127.0.0.1:8788/api';
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + extra}`);
  if (!cond) failures++;
};
async function call(path, { method = 'GET', token, apiKey, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-connectx-key'] = apiKey;
  const res = await fetch(BASE + '/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// 1. bootstrap + setup
let r = await call('control/bootstrap');
ok('bootstrap uninitialized', r.data.initialized === false, JSON.stringify(r.data));
r = await call('control/setup', { method: 'POST', body: { name: 'Owner', email: 'owner@demo.test', password: 'demo-secret-123' } });
const ownerToken = r.data.token;
ok('setup creates owner', !!ownerToken, JSON.stringify(r.data));

// 2. seeded systems + configure EMS
r = await call('control/systems', { token: ownerToken });
const keys = (r.data || []).map(s => s.system_key).sort().join(',');
ok('seeded systems', keys === 'careos,ems,influenceos,plugx', keys);
const ems = (r.data || []).find(s => s.system_key === 'ems');
r = await call(`control/systems/${ems.id}`, { method: 'PATCH', token: ownerToken, body: { api_url: 'http://127.0.0.1:8799', auth_mode: 'federated' } });
ok('EMS api_url configured (federated section)', r.data.system?.api_url === 'http://127.0.0.1:8799' && r.data.system?.login_path === 'api/auth/admin/login', JSON.stringify(r.data.system));

// 3. phone: system dropdown + federated login
r = await call('device/systems');
ok('device/systems lists 4, EMS available', r.data.systems?.length === 4 && r.data.systems.find(s => s.key === 'ems')?.available === true, JSON.stringify(r.data));
ok('device/systems hides api urls', !JSON.stringify(r.data).includes('127.0.0.1'));
r = await call('device/auth/login', { method: 'POST', body: { system: 'ems', email: 'admin@ems.test', password: 'wrong' } });
ok('bad password rejected', r.status === 401 && /Wrong email/i.test(r.data.error || ''), JSON.stringify(r.data));
r = await call('device/auth/login', { method: 'POST', body: { system: 'ems', email: 'admin@ems.test', password: 'ems-secret-123' } });
const adminToken = r.data.token;
ok('federated login ok + shops synced', !!adminToken && r.data.shops?.length === 2, JSON.stringify(r.data).slice(0, 300));
const shop1 = r.data.shops?.find(s => s.external_id === 'store-1');

// 4. device register + heartbeat
r = await call('device/register', { method: 'POST', token: adminToken, body: { shopId: shop1.id, deviceName: 'E2E Pixel', androidVersion: '15', appVersion: '2.1.0', simCarrier: 'Grameenphone', phoneNumber: '+8801711111111' } });
const deviceToken = r.data.deviceToken;
ok('device registered for shop', !!deviceToken && r.data.shop?.name === 'Dhaka Main', JSON.stringify(r.data).slice(0, 300));
r = await call('device/heartbeat', { method: 'POST', token: deviceToken });
ok('heartbeat accepted', r.data.ok === true || r.status === 200, JSON.stringify(r.data));

// 5. API key + client SMS
r = await call(`control/systems/${ems.id}/keys`, { method: 'POST', token: ownerToken, body: { label: 'E2E key', daily_limit: 20 } });
const apiKey = r.data.api_key;
ok('api key issued', !!apiKey, JSON.stringify(r.data));
r = await call('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-1', to: '+8801712345678', recipient_name: 'Rahim', message: 'E2E invoice SMS', message_type: 'SALE', reference_number: 'INV-E2E', idempotency_key: 'E2E:1' } });
const jobId = r.data.job_id;
ok('client SMS queued for shop', r.data.status === 'queued' && r.data.shop === 'store-1', JSON.stringify(r.data));
r = await call('client/v1/sms', { method: 'POST', apiKey, body: { shop: 'store-77', shop_name: 'Auto Shop', to: '+8801700000007', message: 'auto-register shop' } });
ok('unknown shop auto-registers', r.data.ok === true && r.data.shop === 'store-77', JSON.stringify(r.data));

// 6. claim + report
r = await call('device/jobs/claim', { method: 'POST', token: deviceToken, body: { limit: 10 } });
const jobs = r.data.jobs || [];
ok('gateway claims its shop jobs', jobs.length >= 1 && jobs.every(j => j.shop_id === shop1.id), JSON.stringify(r.data).slice(0, 300));
let reported = 0;
for (const j of jobs) {
  const rr = await call('device/jobs/report', { method: 'POST', token: deviceToken, body: { jobId: j.id, status: 'sent' } });
  if (rr.data.status === 'sent') reported++;
}
ok('all claimed jobs reported sent', reported === jobs.length, `${reported}/${jobs.length}`);
r = await call('device/me', { token: deviceToken });
ok('device active after report', r.data.device?.status === 'active', JSON.stringify(r.data.device));
r = await call(`client/v1/sms/${jobId}`, { apiKey });
ok('client can read job status', r.data.status === 'sent', JSON.stringify(r.data).slice(0, 200));

// 7. pairing code (shop 2)
const shop2 = (await call('device/shops', { token: adminToken })).data.shops.find(s => s.external_id === 'store-2');
r = await call('control/devices/pairing-code', { method: 'POST', token: ownerToken, body: { shop_id: shop2.id, ttl_minutes: 15 } });
const code = r.data.code;
ok('pairing code generated', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code || ''), JSON.stringify(r.data));
r = await call('device/pair', { method: 'POST', body: { code, deviceName: 'E2E Galaxy', androidVersion: '14', simCarrier: 'Robi', phoneNumber: '+8801822222222' } });
ok('phone paired via code', !!r.data.deviceToken && r.data.shop?.name === 'Chattogram Branch', JSON.stringify(r.data).slice(0, 300));

// 8. email send through the mock provider
r = await call('control/email', { method: 'PATCH', token: ownerToken, body: { provider: 'brevo', api_key: 'xkb-e2e', from_name: 'ConnectX', from_email: 'no-reply@demo.test', enabled: true } });
ok('email provider configured', r.data.api_key_set === true, JSON.stringify(r.data));
r = await call('client/v1/email/send', { method: 'POST', apiKey, body: { shop: 'store-1', to: 'customer@demo.test', subject: 'E2E invoice', body: 'Thanks for your purchase.' } });
ok('email sent (mocked)', r.data.status === 'sent' && String(r.data.provider_message_id || '').startsWith('mock-'), JSON.stringify(r.data));
r = await call('device/emails?page=0', { token: deviceToken });
ok('phone sees email history', (r.data.items || []).some(e => e.subject === 'E2E invoice'), JSON.stringify(r.data).slice(0, 200));

// 9. console views
r = await call('control/dashboard?utcOffsetMinutes=360', { token: ownerToken });
ok('dashboard counts', r.data.shops?.total >= 3 && r.data.systems?.connected === 1 && r.data.devices?.total === 2, JSON.stringify({ shops: r.data.shops, systems: r.data.systems, devices: r.data.devices }));
r = await call('control/jobs?limit=5', { token: ownerToken });
ok('jobs list shows shop+system', r.data.items?.length >= 3 && r.data.items[0].shop_name && r.data.items[0].system_name, JSON.stringify(r.data.items?.[0]).slice(0, 300));
r = await call('control/shops?search=Auto', { token: ownerToken });
ok('shops search finds auto-registered', (r.data || []).some(s => s.external_id === 'store-77'), JSON.stringify(r.data).slice(0, 200));

// 10. EMS Public API v1 mode (api_key): switch modes, sign in, pull, report back
const MOCK = 'http://127.0.0.1:8799';
const FULL_KEY = 'emsk_' + 'ab'.repeat(32);
const LIMITED_KEY = 'emsk_' + 'cd'.repeat(32);
const mockCall = async (path, body) => {
  const res = await fetch(MOCK + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + FULL_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
};
r = await call(`control/systems/${ems.id}`, { method: 'PATCH', token: ownerToken, body: { auth_mode: 'api_key', api_key: FULL_KEY } });
ok('EMS switched to api_key mode (paths auto-swap)',
  r.data.system?.auth_mode === 'api_key' && r.data.system?.login_path === 'api/v1/auth/login' && r.data.system?.shops_path === 'api/v1/shops',
  JSON.stringify(r.data.system));
ok('stored key is masked, never echoed',
  r.data.system?.api_key_set === true && r.data.system?.api_key_hint === FULL_KEY.slice(0, 13) + '…' && !JSON.stringify(r.data).includes(FULL_KEY),
  JSON.stringify(r.data.system).slice(0, 200));
r = await call('device/auth/login', { method: 'POST', body: { system: 'ems', email: 'blocked@ems.test', password: 'ems-secret-123' } });
ok('v1: entitlement without ConnectX blocked', r.status === 403 && /not enabled/i.test(r.data.error || ''), JSON.stringify(r.data));
await call(`control/systems/${ems.id}`, { method: 'PATCH', token: ownerToken, body: { api_key: LIMITED_KEY } });
r = await call('device/auth/login', { method: 'POST', body: { system: 'ems', email: 'admin@ems.test', password: 'ems-secret-123' } });
ok('v1: missing auth:login scope surfaces owner hint', r.status === 403 && /auth:login scope/i.test(r.data.error || ''), JSON.stringify(r.data));
await call(`control/systems/${ems.id}`, { method: 'PATCH', token: ownerToken, body: { api_key: FULL_KEY } });
r = await call('device/auth/login', { method: 'POST', body: { system: 'ems', email: 'admin@ems.test', password: 'ems-secret-123' } });
const adminToken2 = r.data.token;
ok('v1: sign-in returns administrator+shops in one call',
  !!adminToken2 && r.data.shops?.length >= 2 && r.data.administrator?.external_id === 'ems-admin-1',
  JSON.stringify(r.data).slice(0, 300));

// queue an SMS inside the mock EMS; the gateway's next poll must pull it
r = { data: await mockCall('/api/v1/sms/send?shop_id=store-1', { phone: '+8801799999999', message: 'Pulled from EMS v1', recipientName: 'Karim' }) };
ok('mock EMS queued a v1 job', r.data.status === 'queued' && !!r.data.id, JSON.stringify(r.data));
r = await call('device/jobs/claim', { method: 'POST', token: deviceToken, body: { limit: 10 } });
const pulled = (r.data.jobs || []).find(j => j.phone_number === '+8801799999999');
ok('gateway poll pulled the v1 job (heartbeat+claim)', !!pulled && pulled.message === 'Pulled from EMS v1', JSON.stringify(r.data.jobs).slice(0, 300));
r = await call('device/jobs/report', { method: 'POST', token: deviceToken, body: { jobId: pulled.id, status: 'sent' } });
ok('pulled job reported sent locally', r.data.status === 'sent', JSON.stringify(r.data));
await new Promise(rs => setTimeout(rs, 800));   // let waitUntil report-backs land
const sink = await fetch(MOCK + '/__reports').then(x => x.json());
ok('delivery reported back to EMS /v1/sms/report',
  (sink.reports || []).some(x => x.jobId && x.status === 'sent' && x.found), JSON.stringify(sink.reports));
const hb = await fetch(MOCK + '/__heartbeat').then(x => x.json());
ok('heartbeats reached EMS (service Online)', hb.count >= 1, JSON.stringify(hb));

// 11. SPA served
const page = await fetch('http://127.0.0.1:8788/');
ok('SPA index served', page.status === 200 && (await page.text()).includes('<div id="root">'));

console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
