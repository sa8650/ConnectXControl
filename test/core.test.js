import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signToken, verifyToken, hashPassword, checkPassword, pairingCode,
  cleanPhone, dayStart, fillTemplate, templateVars, isPackage, isVersion
} from '../functions/_lib/core.js';

const SECRET = 'unit-test-secret';

test('signToken/verifyToken round-trips and rejects tampering', async () => {
  const token = await signToken({ id: 'abc', role: 'owner', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const payload = await verifyToken(token, SECRET);
  assert.equal(payload.id, 'abc');
  assert.equal(payload.role, 'owner');

  assert.equal(await verifyToken(token, 'wrong-secret'), null);
  const [h, p, s] = token.split('.');
  assert.equal(await verifyToken(`${h}.${p}.AAAA${s.slice(4)}`, SECRET), null);
  assert.equal(await verifyToken('garbage', SECRET), null);
  assert.equal(await verifyToken(null, SECRET), null);
});

test('expired tokens are rejected', async () => {
  const token = await signToken({ id: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
  assert.equal(await verifyToken(token, SECRET), null);
});

test('password hashing verifies and rejects wrong passwords', async () => {
  const hash = await hashPassword('connectx-rocks-2026');
  assert.match(hash, /^pbkdf2\$100000\$/);
  assert.equal(await checkPassword('connectx-rocks-2026', hash), true);
  assert.equal(await checkPassword('wrong-password', hash), false);
  assert.equal(await checkPassword('x', 'not-a-hash'), false);
});

test('pairing codes are unambiguous and formatted', () => {
  for (let i = 0; i < 50; i++) {
    const code = pairingCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  }
});

test('cleanPhone keeps valid numbers only', () => {
  assert.equal(cleanPhone('+880 1712-345 678'), '+8801712345678');
  assert.equal(cleanPhone('123'), '');
  assert.equal(cleanPhone(''), '');
});

test('dayStart honours UTC offsets', () => {
  const utc = dayStart(null);
  assert.match(utc, /^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  const plus6 = dayStart('360'); // Asia/Dhaka
  assert.match(plus6, /T18:00:00\.000Z$|T18:00:00Z$/); // midnight +06 == 18:00Z previous day
  assert.equal(dayStart('99999'), null);
  assert.equal(dayStart('abc'), null);
});

test('templates fill placeholders', () => {
  const vars = templateVars('Dhaka Main', { name: 'Rahim', invoice: 'INV-9', total: 5400, paid: 5000, due: 400 });
  const out = fillTemplate('Hi {name}, thanks for your purchase at {shop}. Invoice {invoice}: total {currency} {total}, due {currency} {due}.', vars);
  assert.equal(out, 'Hi Rahim, thanks for your purchase at Dhaka Main. Invoice INV-9: total BDT 5,400.00, due BDT 400.00.');
});

test('validators', () => {
  assert.equal(isPackage('com.connectx.gateway'), true);
  assert.equal(isPackage('not a package'), false);
  assert.equal(isVersion('2.0.0'), true);
  assert.equal(isVersion('v2'), false);
});
