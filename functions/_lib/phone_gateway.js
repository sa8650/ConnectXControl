/* Phone sign-in. The app talks only to ConnectX. There is no pairing
   code and no approval. ConnectX asks the connected product (EMS, …)
   to verify the administrator, then the existing app screens use the
   device token issued here. */

import { all, get, insert, update, run, parseJson } from './db.js';
import { json, fail, uuid, nowIso, str, signToken, verifyToken, bearerOf, dayStart, bool } from './core.js';
import { ensureIdentity, callbackProduct, releaseStale } from './connect.js';
import { signEnvelope, postConnect } from './connect_protocol.js';

const ADMIN_TTL = 8 * 60 * 60;
const DEVICE_TTL = 30 * 24 * 60 * 60;

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function products(env) {
  return all(env, `
    SELECT * FROM cx_connect_connections
    WHERE status = 'ACTIVE' AND remote_kind != 'android' AND remote_endpoint != ''
    ORDER BY connected_at ASC
  `).catch(() => []);
}

function systemOf(conn) {
  return {
    key: conn.id,
    name: conn.display_name || conn.remote_application_name || 'Connected app',
    available: true
  };
}

async function callProduct(env, conn, action, payload) {
  const ident = await ensureIdentity(env, { url: 'https://connectxweb.pages.dev/connect' });
  if (!ident.ready) return { httpOk: false, status: 503, data: { error: ident.error } };
  const envelope = await signEnvelope({
    action,
    applicationId: ident.application_id,
    connectionId: conn.id,
    secret: conn.shared_secret,
    payload
  });
  return postConnect(conn.remote_endpoint, envelope);
}

async function adminToken(env, conn, admin) {
  return signToken({
    role: 'phone_admin',
    connection_id: conn.id,
    admin_id: admin.id,
    email: admin.email || '',
    exp: Math.floor(Date.now() / 1000) + ADMIN_TTL
  }, env.SESSION_SECRET);
}

async function phoneSession(env, request) {
  const payload = await verifyToken(bearerOf(request), env.SESSION_SECRET);
  if (!payload || payload.role !== 'phone_admin' || !payload.connection_id || !payload.admin_id) return null;
  const conn = await get(env, "SELECT * FROM cx_connect_connections WHERE id = ? AND status = 'ACTIVE'", payload.connection_id);
  if (!conn) return null;
  return { payload, conn };
}

async function deviceSession(env, request) {
  const payload = await verifyToken(bearerOf(request), env.SESSION_SECRET);
  if (!payload || payload.role !== 'phone' || !payload.id) return null;
  const device = await get(env, 'SELECT * FROM cx_phone_devices WHERE id = ?', payload.id);
  if (!device || device.status === 'disconnected') return null;
  const conn = await get(env, "SELECT * FROM cx_connect_connections WHERE id = ? AND status IN ('ACTIVE', 'PAUSED')", device.connection_id);
  if (!conn) return null;
  return { payload, device, conn };
}

function shopShape(device) {
  return {
    id: device.shop_id,
    name: device.shop_name || 'Shop',
    address: device.shop_address || '',
    phone: device.shop_phone || '',
    shop_code: device.shop_code || '',
    category: ''
  };
}

function adminShape(device) {
  return {
    id: device.admin_id,
    name: device.admin_name || '',
    email: device.admin_email || '',
    admin_code: device.admin_code || null,
    phone: '',
    address: '',
    active: true
  };
}

function jobShop(job) {
  const meta = parseJson(job?.meta, {}) || {};
  return String(job?.shop_id || meta.shop_id || '').trim();
}

function sameId(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

/** A pending shop SMS must reach the signed-in phone even if meta.shop_id
    was missing or the web listed the job without the phone's filter. */
function visibleToPhone(job, device, claim) {
  if (!job || !device) return false;
  const shop = jobShop(job);
  const shopOk = !shop || sameId(shop, device.shop_id);
  const sameConn = job.connection_id === device.connection_id;
  const moving = job.status === 'PENDING' || job.status === 'PROCESSING';
  if (job.device_connection_id && job.device_connection_id === device.id) return true;
  if (sameConn && shopOk) return true;
  const ownedElsewhere = shop && (claim?.shops || []).some(s => sameId(s, shop));
  if (sameConn && claim?.newest && moving && !ownedElsewhere) return true;
  if (claim?.only && moving && !ownedElsewhere) return true;
  return false;
}

async function claimRights(env, device) {
  const phones = await all(env, `
    SELECT id, shop_id, last_seen_at FROM cx_phone_devices
    WHERE connection_id = ? AND status != 'disconnected'
  `, device.connection_id).catch(() => []);
  const allPhones = await all(env, `SELECT id FROM cx_phone_devices WHERE status != 'disconnected'`).catch(() => []);
  const newest = [...phones].sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))[0];
  return {
    only: allPhones.length <= 1,
    newest: !phones.length || newest?.id === device.id,
    shops: phones.map(p => p.shop_id).filter(s => s && !sameId(s, device.shop_id))
  };
}

async function jobsForPhone(env, device) {
  const claim = await claimRights(env, device);
  const own = await all(env, `
    SELECT * FROM cx_connect_jobs WHERE connection_id = ? ORDER BY created_at DESC LIMIT 250
  `, device.connection_id).catch(() => []);
  const extra = claim.only
    ? await all(env, `
        SELECT * FROM cx_connect_jobs
        WHERE status IN ('PENDING', 'PROCESSING') OR device_connection_id = ?
        ORDER BY created_at DESC LIMIT 80
      `, device.id).catch(() => [])
    : [];
  const seen = new Set();
  const out = [];
  for (const job of [...own, ...extra]) {
    if (!job || seen.has(job.id)) continue;
    seen.add(job.id);
    if (visibleToPhone(job, device, claim)) out.push(job);
  }
  return out;
}

function appStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'SENT') return 'sent';
  if (s === 'FAILED') return 'failed';
  if (s === 'PROCESSING' || s === 'SENDING') return 'sending';
  return 'queued';
}

function historyKey(item) {
  return item?.request_id ? 'r:' + item.request_id : 'i:' + (item?.id || '');
}

function mergeSmsHistory(jobs, remoteItems) {
  const map = new Map();
  for (const item of remoteItems || []) {
    if (item?.id) map.set(historyKey(item), item);
  }
  for (const job of jobs || []) {
    const item = activityItem(job);
    const key = historyKey(item);
    const prev = map.get(key);
    if (!prev) { map.set(key, item); continue; }
    map.set(key, {
      ...prev,
      ...item,
      recipient_name: prev.recipient_name && prev.recipient_name !== 'Recipient' ? prev.recipient_name : item.recipient_name,
      message_type: prev.message_type || item.message_type,
      event_type: prev.event_type || item.event_type,
      message_body: item.message_body || prev.message_body,
      error_message: item.error_message || prev.error_message,
      status: item.status || prev.status
    });
  }
  return [...map.values()].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

const smsHistoryCache = new Map();
async function shopSms(env, device, conn, since) {
  const live = await jobsForPhone(env, device);
  const cacheKey = `${device.connection_id}|${device.shop_id}|${since || ''}`;
  const hit = smsHistoryCache.get(cacheKey);
  let remoteItems = hit && Date.now() - hit.at < 20000 ? hit.items : null;
  if (!remoteItems) {
    remoteItems = [];
    try {
      const res = await callProduct(env, conn, 'APP_SMS', {
        op: 'list', admin_id: device.admin_id, shop_id: device.shop_id, since: since || '1970-01-01T00:00:00.000Z'
      });
      if (res.httpOk && res.data?.ok !== false) remoteItems = res.data.items || [];
    } catch { remoteItems = []; }
    smsHistoryCache.set(cacheKey, { at: Date.now(), items: remoteItems });
  }
  const merged = mergeSmsHistory(live, remoteItems);
  if (!since) return merged;
  return merged.filter(item => item.created_at >= since || item.status === 'queued' || item.status === 'sending');
}

function activityItem(job) {
  const meta = parseJson(job.meta, {}) || {};
  return {
    id: job.id,
    request_id: job.request_id || '',
    to_phone: job.recipient,
    recipient_name: meta.recipient_name || 'Recipient',
    message_type: meta.message_type || 'SMS',
    event_type: meta.message_type || 'SMS',
    status: appStatus(job.status),
    error_message: job.reason || '',
    message_body: job.message,
    created_at: job.created_at,
    sent_at: job.result_at || ''
  };
}

let phoneColumnsReady = false;
async function ensurePhoneColumns(env) {
  if (phoneColumnsReady) return;
  for (const sql of [
    'ALTER TABLE cx_phone_devices ADD COLUMN app_version TEXT',
    'ALTER TABLE cx_phone_devices ADD COLUMN version_code INTEGER',
    'ALTER TABLE cx_phone_devices ADD COLUMN android_version TEXT'
  ]) {
    await run(env, sql).catch(() => {});
  }
  phoneColumnsReady = true;
}

async function notePhone(env, device, body) {
  await ensurePhoneColumns(env);
  const patch = { last_seen_at: nowIso() };
  if (body?.appVersion) patch.app_version = str(body.appVersion, 40);
  if (body?.versionCode) patch.version_code = Number(body.versionCode) || null;
  if (body?.androidVersion) patch.android_version = str(body.androidVersion, 40);
  try {
    await update(env, 'cx_phone_devices', patch, 'id = ?', device.id);
  } catch (error) {
    if (!/no such column/i.test(String(error?.message || error))) return;
    await update(env, 'cx_phone_devices', { last_seen_at: nowIso() }, 'id = ?', device.id).catch(() => {});
  }
}

async function controlOperator(env, request) {
  const payload = await verifyToken(bearerOf(request), env.SESSION_SECRET);
  if (!payload || !['owner', 'operator'].includes(payload.role)) return null;
  const op = await get(env, 'SELECT * FROM cx_operators WHERE id = ?', payload.id);
  if (!op || !bool(op.active)) return null;
  return op;
}

function online(row) {
  if (!row?.last_seen_at || row.status === 'disconnected') return false;
  return Date.now() - new Date(row.last_seen_at).getTime() < 3 * 60 * 1000;
}

async function phonesOverview(env, request) {
  const op = await controlOperator(env, request);
  if (!op) return fail('Please sign in.', 401);
  await ensurePhoneColumns(env);
  let rows = [];
  try {
    rows = await all(env, 'SELECT * FROM cx_phone_devices ORDER BY created_at DESC');
  } catch (error) {
    if (/no such table/i.test(String(error?.message || error))) {
      return json({ installed: 0, online: 0, versions: [], phones: [] });
    }
    throw error;
  }
  const installed = rows.filter(r => r.status !== 'disconnected');
  const versions = [];
  for (const row of installed) {
    const version = row.app_version || 'Not reported';
    const build = row.version_code || 0;
    let bucket = versions.find(v => v.app_version === version && v.version_code === build);
    if (!bucket) {
      bucket = { app_version: version, version_code: build, count: 0 };
      versions.push(bucket);
    }
    bucket.count += 1;
  }
  return json({
    installed: installed.length,
    online: installed.filter(online).length,
    versions,
    phones: rows.map(r => ({
      id: r.id,
      device_name: r.device_name || 'Android phone',
      shop_name: r.shop_name || '',
      admin_email: r.admin_email || '',
      admin_name: r.admin_name || '',
      status: r.status,
      online: online(r),
      app_version: r.app_version || '',
      version_code: r.version_code || null,
      android_version: r.android_version || '',
      last_seen_at: r.last_seen_at || null,
      created_at: r.created_at
    }))
  });
}

export async function phoneGatewayRoutes(ctx) {
  const { env, request, path, method, url } = ctx;
  if (path === 'control/phones' && method === 'GET') return phonesOverview(env, request);
  if (!path.startsWith('device/')) return null;
  const body = await readJson(request);

  if (path === 'device/systems' && method === 'GET') {
    const rows = await products(env);
    return json({ systems: rows.map(systemOf) });
  }

  if (path === 'device/auth/login' && method === 'POST') {
    const key = str(body.system || body.systemKey || '', 80);
    const email = str(body.email || body.userId || body.user_id || '', 160);
    const password = String(body.password || '');
    if (!key) return fail('Select the system where your account is registered.', 400);
    if (!email || !password) return fail('Email or Administrator ID, and a password, are required.', 400);
    const conn = await get(env, "SELECT * FROM cx_connect_connections WHERE id = ? AND status = 'ACTIVE'", key);
    if (!conn || !conn.remote_endpoint) return fail('That system is not connected to ConnectX.', 404);
    const res = await callProduct(env, conn, 'VERIFY_ADMIN', { email, password });
    if (!res.httpOk || res.data?.ok === false) {
      const status = res.status === 401 || res.status === 403 ? res.status : 502;
      return fail(res.data?.error || 'The system could not verify that account.', status);
    }
    const admin = res.data.administrator;
    if (!admin?.id) return fail('The system returned an unexpected sign-in result.', 502);
    const token = await adminToken(env, conn, admin);
    return json({
      token,
      administrator: admin,
      system: systemOf(conn),
      shops: Array.isArray(res.data.shops) ? res.data.shops : []
    });
  }

  if (path === 'device/shops' && method === 'GET') {
    const sess = await phoneSession(env, request);
    if (!sess) return fail('Administrator sign-in required.', 403);
    const res = await callProduct(env, sess.conn, 'APP_SHOPS', { admin_id: sess.payload.admin_id });
    if (!res.httpOk || res.data?.ok === false) return fail(res.data?.error || 'Could not load shops.', 502);
    return json({
      administrator: res.data.administrator,
      system: systemOf(sess.conn),
      shops: res.data.shops || []
    });
  }

  if (path === 'device/register' && method === 'POST') {
    const sess = await phoneSession(env, request);
    if (!sess) return fail('Administrator sign-in required.', 403);
    const shopId = str(body.shopId || body.shop_id || '', 80);
    if (!shopId) return fail('Shop is required.', 400);
    const listed = await callProduct(env, sess.conn, 'APP_SHOPS', { admin_id: sess.payload.admin_id });
    const shop = (listed.data?.shops || []).find(s => s.id === shopId);
    if (!listed.httpOk || !shop) return fail('That shop is not available for this administrator.', 404);
    const id = uuid();
    const row = {
      id,
      connection_id: sess.conn.id,
      admin_id: sess.payload.admin_id,
      admin_email: listed.data.administrator?.email || sess.payload.email || '',
      admin_name: listed.data.administrator?.name || '',
      admin_code: listed.data.administrator?.admin_code || '',
      shop_id: shop.id,
      shop_name: shop.name || 'Shop',
      shop_address: shop.address || '',
      shop_phone: shop.phone || '',
      shop_code: shop.shop_code || '',
      device_name: str(body.deviceName || 'Android phone', 80),
      sim_subscription_id: Number(body.simSubscriptionId || 0),
      sim_carrier: str(body.simCarrier || '', 80),
      phone_number: str(body.phoneNumber || '', 40),
      status: 'pending_test',
      last_seen_at: nowIso(),
      created_at: nowIso()
    };
    const version = {
      app_version: str(body.appVersion || body.app_version || '', 40),
      version_code: Number(body.versionCode || body.version_code) || null,
      android_version: str(body.androidVersion || body.android_version || '', 40)
    };
    await ensurePhoneColumns(env);
    try {
      await insert(env, 'cx_phone_devices', { ...row, ...version });
    } catch (error) {
      const msg = String(error?.message || error);
      if (/no such table/i.test(msg)) {
        return fail('Apply schema/migrate_connect_app.sql before phones can sign in.', 503);
      }
      if (/no such column/i.test(msg)) await insert(env, 'cx_phone_devices', row);
      else throw error;
    }
    const deviceToken = await signToken({
      role: 'phone', id, connection_id: sess.conn.id, shop_id: shop.id,
      exp: Math.floor(Date.now() / 1000) + DEVICE_TTL
    }, env.SESSION_SECRET);
    return json({
      device: { id, device_public_id: id.slice(0, 8).toUpperCase(), status: 'pending_test' },
      deviceToken,
      shop: { id: shop.id, name: shop.name, address: shop.address || '' },
      system: systemOf(sess.conn),
      administrator: listed.data.administrator
    }, 201);
  }

  if (path === 'device/pair' && method === 'POST') {
    return fail('This phone connects by signing in. Pairing codes are not used.', 410);
  }

  const sess = await deviceSession(env, request);
  if (!sess) return fail('Sign in again to use this phone.', 401);
  const { device, conn } = sess;
  await notePhone(env, device, body);

  if (path === 'device/me' && method === 'GET') {
    const remote = await callProduct(env, conn, 'APP_SHOPS', { admin_id: device.admin_id });
    return json({
      administrator: remote.data?.administrator || adminShape(device),
      shop: shopShape(device),
      system: systemOf(conn)
    });
  }
  if (path === 'device/heartbeat' && method === 'POST') {
    const jobs = await jobsForPhone(env, device);
    const pending = jobs.filter(j => j.status === 'PENDING' || j.status === 'PROCESSING').length;
    return json({ ok: true, pending });
  }
  if (path === 'device/test' && method === 'POST') {
    await update(env, 'cx_phone_devices', { status: 'active', last_seen_at: nowIso() }, 'id = ?', device.id);
    return json({ ok: true });
  }
  if (path === 'device/sim' && method === 'PATCH') {
    await update(env, 'cx_phone_devices', {
      sim_subscription_id: Number(body.simSubscriptionId || device.sim_subscription_id || 0),
      sim_carrier: str(body.simCarrier || device.sim_carrier, 80),
      phone_number: str(body.phoneNumber || device.phone_number, 40),
      last_seen_at: nowIso()
    }, 'id = ?', device.id);
    return json({ ok: true });
  }
  if (path === 'device/sim-carrier' && method === 'GET') return fail('SIM balance has been removed.', 410);
  if (path === 'device/disconnect' && method === 'POST') {
    await update(env, 'cx_phone_devices', { status: 'disconnected' }, 'id = ?', device.id);
    return json({ ok: true });
  }

  if (path === 'device/jobs/claim' && method === 'POST') {
    if (conn.status === 'PAUSED') return json({ jobs: [] });
    await releaseStale(env);
    const limit = Math.min(8, Math.max(1, Number(body.limit) || 5));
    const jobs = (await jobsForPhone(env, device))
      .filter(j => j.status === 'PENDING')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, limit);
    const claimed = [];
    for (const job of jobs) {
      await update(env, 'cx_connect_jobs', {
        status: 'PROCESSING', device_connection_id: device.id, updated_at: nowIso()
      }, "id = ? AND status = 'PENDING'", job.id);
      const fresh = await get(env, "SELECT * FROM cx_connect_jobs WHERE id = ? AND status = 'PROCESSING' AND device_connection_id = ?", job.id, device.id);
      if (!fresh) continue;
      claimed.push({
        id: fresh.id,
        shop_id: device.shop_id,
        phone_number: fresh.recipient,
        message: fresh.message,
        event_type: 'SMS',
        message_type: 'SMS',
        recipient_name: 'Recipient',
        created_at: fresh.created_at
      });
    }
    return json({ jobs: claimed });
  }

  if (path === 'device/jobs/report' && method === 'POST') {
    const id = str(body.jobId || body.id || '', 80);
    const sent = body.status === 'sent' || body.sent === true;
    const job = await get(env, 'SELECT * FROM cx_connect_jobs WHERE id = ?', id);
    if (!job || !visibleToPhone(job, device, await claimRights(env, device))) return fail('SMS job not found for this shop.', 404);
    if (job.device_connection_id && job.device_connection_id !== device.id && job.status !== 'PENDING') {
      return fail('This task belongs to another phone.', 403);
    }
    if (job.status === 'SUCCESS' || job.status === 'FAILED') return json({ ok: true, duplicate: true, status: job.status === 'SUCCESS' ? 'sent' : 'failed' });
    const status = sent ? 'SUCCESS' : 'FAILED';
    await update(env, 'cx_connect_jobs', {
      status,
      reason: sent ? '' : str(body.error || 'SMS could not be sent', 400),
      sim_used: str(device.sim_carrier || device.phone_number || '', 120),
      result_at: nowIso(),
      device_connection_id: device.id,
      callback_status: 'PENDING',
      updated_at: nowIso()
    }, 'id = ?', job.id);
    const updated = await get(env, 'SELECT * FROM cx_connect_jobs WHERE id = ?', job.id);
    await callbackProduct(env, updated);
    if (device.status !== 'active') await update(env, 'cx_phone_devices', { status: 'active' }, 'id = ?', device.id);
    return json({ ok: true, status: sent ? 'sent' : 'failed' });
  }

  if (path === 'device/jobs/cancel' && method === 'POST') {
    const id = str(body.jobId || body.id || '', 80);
    const changed = await update(env, 'cx_connect_jobs', {
      status: 'FAILED', reason: 'Cancelled on the phone', result_at: nowIso(), callback_status: 'PENDING', updated_at: nowIso()
    }, "id = ? AND connection_id = ? AND status = 'PENDING'", id, conn.id);
    if (!changed) return json({ cancelled: false });
    const job = await get(env, 'SELECT * FROM cx_connect_jobs WHERE id = ?', id);
    if (job) await callbackProduct(env, job);
    return json({ cancelled: true });
  }

  if (path === 'device/stats' && method === 'GET') {
    const today = dayStart(url.searchParams.get('utcOffsetMinutes'));
    if (!today) return fail('Invalid UTC offset.', 400);
    const items = await shopSms(env, device, conn, today);
    const last = items[0];
    return json({
      sent: items.filter(r => r.status === 'sent' && r.created_at >= today).length,
      failed: items.filter(r => r.status === 'failed' && r.created_at >= today).length,
      pending: items.filter(r => r.status === 'queued' || r.status === 'sending').length,
      lastActivity: last?.sent_at || last?.created_at || null,
      shop: shopShape(device),
      system: systemOf(conn),
      administrator: adminShape(device),
      device: { device_public_id: device.id.slice(0, 8).toUpperCase() }
    });
  }

  if (path === 'device/activity' && method === 'GET') {
    const range = url.searchParams.get('range') || 'today';
    const since = range === 'all'
      ? '1970-01-01T00:00:00.000Z'
      : range === 'today'
        ? dayStart(url.searchParams.get('utcOffsetMinutes'))
        : new Date(Date.now() - (range === '30d' ? 30 : 7) * 86400000).toISOString();
    if (!since) return fail('Invalid UTC offset.', 400);
    const limit = Math.min(80, Math.max(1, Number(url.searchParams.get('limit') || 40)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const items = await shopSms(env, device, conn, since);
    return json({ items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit, total: items.length });
  }

  if (path === 'device/emails/stats' && method === 'GET') {
    const since = dayStart(url.searchParams.get('utcOffsetMinutes'));
    const res = await callProduct(env, conn, 'APP_EMAILS', { op: 'stats', admin_id: device.admin_id, shop_id: device.shop_id, since });
    if (!res.httpOk || res.data?.ok === false) return fail(res.data?.error || 'Email history is unavailable.', 502);
    return json({ sent: res.data.sent || 0, failed: res.data.failed || 0, pending: res.data.pending || 0, latest: res.data.latest || null });
  }
  if (path === 'device/emails' && method === 'GET') {
    const page = Number(url.searchParams.get('page') || 0);
    const res = await callProduct(env, conn, 'APP_EMAILS', { op: 'page', admin_id: device.admin_id, shop_id: device.shop_id, page });
    if (!res.httpOk || res.data?.ok === false) return fail(res.data?.error || 'Email history is unavailable.', 502);
    return json({ items: res.data.items || [], page: res.data.page || 0, snapshot: res.data.snapshot || nowIso(), hasMore: !!res.data.hasMore });
  }
  if (path.startsWith('device/emails/') && method === 'GET') {
    const emailId = decodeURIComponent(path.slice('device/emails/'.length));
    const res = await callProduct(env, conn, 'APP_EMAILS', { op: 'detail', admin_id: device.admin_id, shop_id: device.shop_id, email_id: emailId });
    if (!res.httpOk || res.data?.ok === false) return fail(res.data?.error || 'Email not found.', res.status === 404 ? 404 : 502);
    return json(res.data.email || {});
  }

  return fail('Unknown phone route.', 404);
}
