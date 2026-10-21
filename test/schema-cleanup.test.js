import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../schema/connectx_schema.sql', import.meta.url), 'utf8');

test('fresh schema is a single comment-free SQL source for active tables', () => {
  assert.doesNotMatch(schema, /--|\/\*/);
  const created = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map(match => match[1]).sort();
  assert.deepEqual(created, [
    'cx_activity_log', 'cx_api_keys', 'cx_connect_connections', 'cx_connect_identity',
    'cx_jobs', 'cx_monitor_device_details', 'cx_monitor_devices', 'cx_monitor_sms',
    'cx_operators', 'cx_phone_devices', 'cx_releases', 'cx_settings', 'cx_shops', 'cx_systems'
  ]);
  for (const retired of [
    'cx_workspaces', 'cx_clients', 'cx_admins', 'cx_devices', 'cx_pairing_codes',
    'cx_sim_carriers', 'cx_connect_requests', 'cx_connect_jobs', 'cx_monitor_enrollments'
  ]) {
    assert.match(schema, new RegExp(`DROP TABLE IF EXISTS ${retired};`));
    assert.doesNotMatch(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${retired}\\b`));
  }
  assert.doesNotMatch(schema, /idx_cx_jobs_external|external_job_id/);
});
