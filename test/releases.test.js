import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequest } from '../functions/api/[[path]].js';
import { signToken } from '../functions/_lib/core.js';
import { createFakeD1 } from '../test-support/fakeD1.js';

const schema = readFileSync(new URL('../schema/connectx_schema.sql', import.meta.url), 'utf8');

test('new release can be saved and then edited by its returned id', async t => {
  const fake = createFakeD1(schema);
  t.after(() => fake.close());
  const now = new Date().toISOString();
  fake.sqlite.prepare(`INSERT INTO cx_operators(id,name,email,password_hash,role,active,created_at,updated_at)
    VALUES('release-owner','Owner','owner@example.test','test','owner',1,?,?)`).run(now, now);
  const env = { DB: fake.DB, SESSION_SECRET: 'test-session-secret-for-releases' };
  const token = await signToken({ id: 'release-owner', role: 'owner', exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  const call = (path, method, payload) => onRequest({
    env,
    request: new Request(`https://control.example.test/api/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }),
    next: async () => new Response('spa')
  });

  const createdResponse = await call('control/releases', 'POST', {
    package_name: 'com.connectx.gateway', title: 'ConnectX', version: '2.3.0', version_code: 23,
    published: false, mandatory: false
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = await createdResponse.json();
  assert.ok(created.release.id);

  const updatedResponse = await call(`control/releases/${encodeURIComponent(created.release.id)}`, 'PATCH', {
    title: 'ConnectX Updated', version: '2.3.1', version_code: 24, published: false
  });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.release.id, created.release.id);
  assert.equal(updated.release.title, 'ConnectX Updated');
  assert.equal(updated.release.version, '2.3.1');
  assert.equal(updated.release.version_code, 24);
});
