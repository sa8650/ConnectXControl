import { all, get, insert, update } from './db.js';
import { bearerOf, fail, isUuid, json, nowIso, sha256, str, uuid } from './core.js';

const STATES = ['processing', 'sent', 'delivered', 'failed', 'unknown', 'cancelled'];
const stateRank = { processing: 1, sent: 2, failed: 3, unknown: 3, cancelled: 4, delivered: 5 };
const onlineCutoff = () => new Date(Date.now() - 3 * 60_000).toISOString();
const dateRange = range => {
  const seconds = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 }[range];
  if (!seconds && range !== 'all') return null;
  return seconds ? new Date(Date.now() - seconds * 1000).toISOString() : null;
};
const tokenValue = () => `cxm_${[...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('')}`;
const iso = value => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const bearer = request => bearerOf(request);

async function authenticatedDevice(env, request, deviceId = '') {
  const token = bearer(request);
  if (!token.startsWith('cxm_')) return null;
  const tokenHash = await sha256(token);
  const query = deviceId
    ? "SELECT * FROM cx_monitor_devices WHERE token_hash = ? AND id = ? AND status = 'active'"
    : "SELECT * FROM cx_monitor_devices WHERE token_hash = ? AND status = 'active'";
  return deviceId ? get(env, query, tokenHash, deviceId) : get(env, query, tokenHash);
}

async function saveDeviceDetails(env, deviceId, body, now) {
  const values = {
    sim_subscription_id: str(body.simSubscriptionId ?? '', 30),
    sim_carrier: str(body.simCarrier || '', 80),
    phone_number: str(body.phoneNumber || '', 40),
    device_status: body.deviceStatus === 'pending_test' ? 'pending_test' : 'active',
    updated_at: now
  };
  const exists = await get(env, 'SELECT device_id FROM cx_monitor_device_details WHERE device_id = ?', deviceId);
  if (exists) await update(env, 'cx_monitor_device_details', values, 'device_id = ?', deviceId);
  else await insert(env, 'cx_monitor_device_details', { device_id: deviceId, ...values });
}

async function registerDevice({ env, request, body }) {
  const id = str(body.emsDeviceId || '', 120);
  const adminId = str(body.adminId || '', 120);
  const shopId = str(body.shopId || '', 120);
  if (!isUuid(id) || !adminId || !shopId)
    return fail('EMS device, administrator, and shop identifiers are required.', 400);

  const prior = await get(env, 'SELECT * FROM cx_monitor_devices WHERE id = ?', id);
  if (prior?.status === 'revoked') return fail('This Control device registration was revoked by an owner.', 403);
  const suppliedToken = bearer(request);
  if (suppliedToken) {
    const authenticated = await authenticatedDevice(env, request, id);
    if (!authenticated || (prior && authenticated.token_hash !== prior.token_hash))
      return fail('Control device token is invalid for this EMS registration.', 401);
  }
  const token = suppliedToken || tokenValue();
  const now = nowIso();
  const tokenHash = await sha256(token);
  const values = {
    token_hash: tokenHash,
    admin_id: adminId,
    admin_code: str(body.adminCode || '', 80),
    admin_name: str(body.adminName || '', 160),
    admin_email: str(body.adminEmail || '', 320).toLowerCase(),
    shop_id: shopId,
    shop_name: str(body.shopName || '', 160),
    device_name: str(body.deviceName || 'Android phone', 160),
    android_version: str(body.androidVersion || '', 80),
    app_version: str(body.appVersion || '', 40),
    version_code: Math.max(0, Math.floor(Number(body.versionCode) || 0)),
    status: 'active',
    last_seen: now,
    updated_at: now
  };
  if (prior) await update(env, 'cx_monitor_devices', values, 'id = ?', id);
  else await insert(env, 'cx_monitor_devices', { id, ...values, created_at: now });
  await saveDeviceDetails(env, id, body, now);
  return json({ ok: true, deviceId: id, token }, prior ? 200 : 201);
}

async function heartbeat({ env, request, body }) {
  const deviceId = str(body.emsDeviceId || '', 120);
  const device = await authenticatedDevice(env, request, deviceId);
  if (!device) return fail('Control device token is invalid for this EMS registration.', 401);
  const adminId = str(body.adminId || '', 120);
  const shopId = str(body.shopId || '', 120);
  if (!adminId || !shopId || shopId !== device.shop_id) return fail('Administrator and registered shop identifiers are required.', 400);
  const now = nowIso();
  await update(env, 'cx_monitor_devices', {
    admin_id: adminId,
    admin_code: str(body.adminCode || '', 80),
    admin_name: str(body.adminName || '', 160),
    admin_email: str(body.adminEmail || '', 320).toLowerCase(),
    shop_id: shopId,
    shop_name: str(body.shopName || '', 160),
    device_name: str(body.deviceName || device.device_name || 'Android phone', 160),
    android_version: str(body.androidVersion || '', 80),
    app_version: str(body.appVersion || '', 40),
    version_code: Math.max(0, Math.floor(Number(body.versionCode) || 0)),
    last_seen: now,
    updated_at: now
  }, 'id = ?', device.id);
  await saveDeviceDetails(env, device.id, body, now);
  return json({ ok: true, lastSeen: now });
}

async function smsEvent({ env, request, body }) {
  const jobId = str(body.jobId || '', 100);
  const shopId = str(body.shopId || '', 120);
  const token = bearer(request);
  if (!token.startsWith('cxm_')) return fail('ConnectX Control device token is invalid or revoked.', 401);
  const tokenHash = await sha256(token);
  const device = await get(env, "SELECT * FROM cx_monitor_devices WHERE token_hash = ? AND shop_id = ? AND status = 'active'", tokenHash, shopId);
  if (!device) return fail('Control device token is invalid for this registered shop.', 401);
  const status = str(body.status || '', 24).toLowerCase();
  const recipient = str(body.recipientPhone || '', 40);
  if (!jobId || !shopId || !STATES.includes(status)) return fail('A job, shop, and valid SMS status are required.', 400);
  if (!recipient || !/^[+0-9 ()-]{6,40}$/.test(recipient)) return fail('A valid recipient phone number is required.', 400);

  const now = nowIso();
  const existing = await get(env, 'SELECT * FROM cx_monitor_sms WHERE job_id = ?', jobId);
  const incomingRank = stateRank[status];
  const resultAt = iso(body.resultAt) || now;
  if (existing) {
    const incomingTime = Date.parse(resultAt);
    const existingTime = Date.parse(existing.result_at || existing.updated_at || '');
    if (incomingTime < existingTime || (incomingTime === existingTime && incomingRank < stateRank[existing.status]))
      return json({ ok: true, duplicate: true, status: existing.status });
  }
  const sentAt = status === 'sent' || status === 'delivered' ? (iso(body.sentAt) || now) : existing?.sent_at || null;
  const deliveredAt = status === 'delivered' ? (iso(body.deliveredAt) || now) : existing?.delivered_at || null;
  const createdAt = iso(body.createdAt) || existing?.created_at || now;
  const values = {
    device_id: device.id,
    admin_id: str(body.adminId || device.admin_id, 120),
    admin_code: str(body.adminCode || device.admin_code, 80),
    admin_name: str(body.adminName || device.admin_name, 160),
    shop_id: shopId,
    shop_name: str(body.shopName || device.shop_name, 160),
    recipient_phone: recipient,
    recipient_name: str(body.recipientName || '', 160),
    message_type: str(body.messageType || 'SMS', 80),
    status,
    attempts: Math.max(0, Math.floor(Number(body.attempts) || 0)),
    error_message: str(body.error || '', 500) || null,
    created_at: createdAt,
    sent_at: sentAt,
    delivered_at: deliveredAt,
    result_at: resultAt,
    app_version: str(body.appVersion || device.app_version, 40),
    version_code: Math.max(0, Math.floor(Number(body.versionCode) || device.version_code || 0)),
    updated_at: now
  };
  if (!existing) {
    try { await insert(env, 'cx_monitor_sms', { id: uuid(), job_id: jobId, ...values }); }
    catch {
      const raced = await get(env, 'SELECT * FROM cx_monitor_sms WHERE job_id = ?', jobId);
      if (!raced) throw new Error('Could not persist the SMS monitoring event.');
      if (incomingRank >= stateRank[raced.status]) await update(env, 'cx_monitor_sms', values, 'job_id = ?', jobId);
    }
  } else {
    await update(env, 'cx_monitor_sms', values, 'job_id = ?', jobId);
  }
  return json({ ok: true, status });
}

export async function telemetryRoutes(ctx) {
  const { env, request, path, method } = ctx;
  let body = {};
  if (method === 'POST') body = await request.json().catch(() => ({}));
  if (path === 'telemetry/enroll' && method === 'POST') return fail('Enrollment codes are retired. Android devices register directly with ConnectX Control.', 410);
  if (path === 'telemetry/register' && method === 'POST') return registerDevice({ env, request, body });
  if (path === 'telemetry/heartbeat' && method === 'POST') return heartbeat({ env, request, body });
  if (path === 'telemetry/sms' && method === 'POST') return smsEvent({ env, request, body });
  if (path === 'telemetry/disconnect' && method === 'POST') {
    const device = await authenticatedDevice(env, request);
    if (!device) return fail('ConnectX Control device token is invalid or revoked.', 401);
    await update(env, 'cx_monitor_devices', { status: 'revoked', updated_at: nowIso() }, 'id = ?', device.id);
    return json({ ok: true });
  }
  return null;
}

export async function controlMonitorRoutes({ env, path, method, op, body, url }) {
  if (path === 'control/monitor/enrollment' && method === 'POST')
    return fail('Enrollment codes are retired. Android devices register directly with ConnectX Control.', 410);
  if (path === 'control/monitor/overview' || path === 'control/dashboard') {
    if (method !== 'GET') return fail('Monitoring is read-only.', 405);
    const range = url.searchParams.get('range') || '24h';
    const since = dateRange(range);
    if (since === null && range !== 'all') return fail('Choose 24h, 7d, 30d, or all.', 400);
    const cutoff = onlineCutoff();
    const smsWhere = since ? ' WHERE created_at >= ?' : '';
    const binds = since ? [since] : [];
    const [activeUsers, registeredUsers, totalDevices, activeDevices, online, revoked, grouped, totalSms, recentRows, latest] = await Promise.all([
      get(env, "SELECT COUNT(DISTINCT admin_id) AS total FROM cx_monitor_devices WHERE status = 'active' AND last_seen >= ?", new Date(Date.now() - 30 * 86400_000).toISOString()),
      get(env, 'SELECT COUNT(DISTINCT admin_id) AS total FROM cx_monitor_devices'),
      get(env, "SELECT COUNT(*) AS total FROM cx_monitor_devices WHERE status != 'revoked'"),
      get(env, "SELECT COUNT(*) AS total FROM cx_monitor_devices WHERE status = 'active'"),
      get(env, "SELECT COUNT(*) AS total FROM cx_monitor_devices WHERE status = 'active' AND last_seen >= ?", cutoff),
      get(env, "SELECT COUNT(*) AS total FROM cx_monitor_devices WHERE status = 'revoked'"),
      all(env, `SELECT status, COUNT(*) AS total FROM cx_monitor_sms${smsWhere} GROUP BY status`, ...binds),
      get(env, `SELECT COUNT(*) AS total FROM cx_monitor_sms${smsWhere}`, ...binds),
      all(env, `SELECT * FROM cx_monitor_sms${smsWhere}${smsWhere ? ' AND' : ' WHERE'} status IN ('failed','unknown') ORDER BY created_at DESC LIMIT 10`, ...binds),
      get(env, "SELECT * FROM cx_monitor_devices WHERE status = 'active' ORDER BY last_seen DESC LIMIT 1")
    ]);
    const counts = Object.fromEntries(STATES.map(state => [state, 0]));
    grouped.forEach(row => { counts[row.status] = Number(row.total || 0); });
    return json({
      range, generatedAt: nowIso(), staleAfterSeconds: 180,
      users: { active: Number(activeUsers?.total || 0), registered: Number(registeredUsers?.total || 0) },
      devices: { registered: Number(totalDevices?.total || 0), online: Number(online?.total || 0), active: Number(activeDevices?.total || 0), offline: Math.max(0, Number(totalDevices?.total || 0) - Number(online?.total || 0)), revoked: Number(revoked?.total || 0) },
      sms: { total: Number(totalSms?.total || 0), processing: counts.processing, sent: counts.sent, delivered: counts.delivered, failed: counts.failed, unknown: counts.unknown, cancelled: counts.cancelled, unsuccessful: counts.failed, recentErrors: recentRows.map(publicSms) },
      mostRecentlySeen: latest ? publicDevice(latest) : null
    });
  }
  if (['control/monitor/devices', 'control/devices', 'control/phones'].includes(path) && method === 'GET') {
    const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get('limit') || 50))));
    const offset = Math.max(0, Math.min(50000, Math.floor(Number(url.searchParams.get('offset') || 0))));
    const status = str(url.searchParams.get('status') || '', 24);
    if (status && !['active', 'offline', 'revoked'].includes(status)) return fail('Invalid device status filter.', 400);
    const where = [];
    const binds = [];
    if (status === 'active' || status === 'revoked') { where.push('status = ?'); binds.push(status); }
    if (status === 'offline') { where.push("status = 'active' AND (last_seen IS NULL OR last_seen < ?)"); binds.push(onlineCutoff()); }
    const filterSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const [itemsRaw, count, online] = await Promise.all([
      all(env, `SELECT d.*, x.sim_subscription_id AS monitor_sim_subscription_id, x.sim_carrier AS monitor_sim_carrier, x.phone_number AS monitor_phone_number, x.device_status AS monitor_device_status FROM cx_monitor_devices d LEFT JOIN cx_monitor_device_details x ON x.device_id = d.id${filterSql.replaceAll('status', 'd.status').replaceAll('last_seen', 'd.last_seen')} ORDER BY d.last_seen DESC LIMIT ? OFFSET ?`, ...binds, limit, offset),
      get(env, `SELECT COUNT(*) AS total FROM cx_monitor_devices${filterSql}`, ...binds),
      get(env, "SELECT COUNT(*) AS total FROM cx_monitor_devices WHERE status = 'active' AND last_seen >= ?", onlineCutoff())
    ]);
    const items = itemsRaw.map(publicDevice);
    const total = Number(count?.total || 0);
    return json({ items, total, online: Number(online?.total || 0), offset, limit, hasMore: offset + items.length < total, serverTime: nowIso() });
  }
  if (['control/monitor/sms', 'control/jobs'].includes(path) && method === 'GET') {
    const range = url.searchParams.get('range') || '30d';
    const since = dateRange(range);
    if (since === null && range !== 'all') return fail('Choose 24h, 7d, 30d, or all.', 400);
    const status = str(url.searchParams.get('status') || '', 24);
    if (status && !STATES.includes(status)) return fail('Invalid SMS status filter.', 400);
    const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get('limit') || 50))));
    const offset = Math.max(0, Math.min(50000, Math.floor(Number(url.searchParams.get('offset') || 0))));
    const where = [];
    const binds = [];
    if (since) { where.push('created_at >= ?'); binds.push(since); }
    if (status) { where.push('status = ?'); binds.push(status); }
    const sql = `SELECT * FROM cx_monitor_sms${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const items = (await all(env, sql, ...binds, limit + 1, offset)).slice(0, limit).map(publicSms);
    const countSql = `SELECT COUNT(*) AS total FROM cx_monitor_sms${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    const total = Number((await get(env, countSql, ...binds))?.total || 0);
    return json({ items, total, offset, limit, hasMore: offset + items.length < total, range, serverTime: nowIso() });
  }
  if (path.startsWith('control/monitor/devices/') && /\/(revoke|restore)$/.test(path) && method === 'POST') {
    if (op.role !== 'owner') return fail('Only the owner can manage device access.', 403);
    const id = decodeURIComponent(path.split('/')[3] || '');
    if (!isUuid(id)) return fail('Invalid device id.', 400);
    const action = path.endsWith('/revoke') ? 'revoke' : 'restore';
    const from = action === 'revoke' ? 'active' : 'revoked';
    const to = action === 'revoke' ? 'revoked' : 'active';
    const changed = await update(env, 'cx_monitor_devices', { status: to, updated_at: nowIso() }, 'id = ? AND status = ?', id, from);
    if (!changed) return fail(`${action === 'revoke' ? 'Active' : 'Revoked'} monitoring device not found.`, 404);
    return json({ ok: true });
  }
  return null;
}

function publicDevice(row) {
  return {
    id: row.id, adminId: row.admin_id, administratorCode: row.admin_code || '', administratorName: row.admin_name || '',
    administratorEmail: row.admin_email || '', shopId: row.shop_id || '', shopName: row.shop_name || '',
    deviceName: row.device_name || 'Android phone', androidVersion: row.android_version || 'Unknown',
    appVersion: row.app_version || 'Unknown', versionCode: Number(row.version_code || 0),
    simSubscriptionId: row.monitor_sim_subscription_id || '', simCarrier: row.monitor_sim_carrier || '',
    phoneNumber: row.monitor_phone_number || '', deviceStatus: row.monitor_device_status || 'active', status: row.status,
    online: row.status === 'active' && row.last_seen >= onlineCutoff(), lastSeen: row.last_seen || null
  };
}

function publicSms(row) {
  return {
    id: row.id, jobId: row.job_id, shopId: row.shop_id, shopName: row.shop_name,
    administratorId: row.admin_id, administratorName: row.admin_name, administratorCode: row.admin_code,
    recipientPhone: row.recipient_phone, recipientName: row.recipient_name, messageType: row.message_type,
    status: row.status, attempts: Number(row.attempts || 0), error: row.error_message,
    createdAt: row.created_at, sentAt: row.sent_at, deliveredAt: row.delivered_at,
    resultAt: row.result_at, appVersion: row.app_version, versionCode: Number(row.version_code || 0)
  };
}
