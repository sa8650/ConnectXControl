/* Mock "EMS-style" external system for local end-to-end testing.
   Implements the federated-auth contract ConnectX calls server-side:
     POST /api/auth/admin/login   {email,password} → {token,user,role}
     GET  /api/connectx/gateway/shops (Bearer)    → {administrator,shops}
     POST /hooks/connectx                        → webhook sink
   Run: node scripts/mock-ems.mjs  (listens on 127.0.0.1:8799) */
import http from 'node:http';

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const ADMIN = { email: 'admin@ems.test', password: 'ems-secret-123' };
const token = () => `${b64u({ alg: 'HS256' })}.${b64u({ id: 'ems-admin-1', role: 'admin', exp: Math.floor(Date.now() / 1000) + 28800 })}.mocksig`;
const webhooks = [];

const SHOPS = [
  { id: 'store-1', name: 'Dhaka Main', address: 'Gulshan 1, Dhaka', phone: '+8801711111111', shop_code: 'DHK-1', status: 'active', category: 'General Store' },
  { id: 'store-2', name: 'Chattogram Branch', address: 'Khulshi, Chattogram', phone: '+8801822222222', shop_code: 'CTG-1', status: 'active', category: 'General Store' }
];

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://127.0.0.1:8799');
    if (url.pathname === '/api/auth/admin/login' && req.method === 'POST') {
      const b = JSON.parse(raw || '{}');
      if (b.email === ADMIN.email && b.password === ADMIN.password)
        return send(200, { token: token(), user: { id: 'ems-admin-1', admin_code: '4321', name: 'EMS Admin', email: b.email }, role: 'admin' });
      if (b.email === 'deact@ems.test')
        return send(403, { error: 'Your administrator account is deactivated. Contact EMS support.' });
      return send(401, { error: 'Wrong email or password.' });
    }
    if (url.pathname === '/api/connectx/gateway/shops' && req.method === 'GET') {
      if (!(req.headers.authorization || '').startsWith('Bearer ')) return send(401, { error: 'Expired' });
      return send(200, { administrator: { id: 'ems-admin-1', admin_code: '4321', name: 'EMS Admin', email: ADMIN.email }, shops: SHOPS });
    }
    if (url.pathname === '/hooks/connectx' && req.method === 'POST') {
      webhooks.push({ headers: { event: req.headers['x-connectx-event'], sig: req.headers['x-connectx-signature'] }, body: JSON.parse(raw || '{}') });
      return send(200, { ok: true });
    }
    if (url.pathname === '/__webhooks') return send(200, { count: webhooks.length, webhooks });
    send(404, { error: 'not found' });
  });
}).listen(8799, '127.0.0.1', () => console.log('mock EMS listening on http://127.0.0.1:8799'));
