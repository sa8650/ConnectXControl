/* =====================================================================
   ConnectX Connect Server
   --------------------------------------------------------------------
   Products (EMS, InfluenceOS, CareOS, …) and the ConnectX Android app
   talk only to this Connect Endpoint. They never share a database.

   Android uses the same protocol. Its Connect Endpoint URL is compiled
   into the app backend and is not shown in the phone UI. Because a
   phone cannot accept an inbound handshake, it polls POLL_PAIRING until
   an administrator approves.

   SMS path
     SEND_SMS → job PENDING
     Android PULL_TASKS → PROCESSING
     Android TASK_RESULT → SUCCESS | FAILED
     SMS_RESULT → originating product Connect Endpoint
   ===================================================================== */

import { all, get, insert, update, run } from './db.js';
import { bearerOf, verifyToken, bool, str, cleanPhone } from './core.js';
import { logActivity } from './audit.js';
import {
  PROTOCOL, applicationId, connectionId, pairingCode, requestToken, sharedSecret,
  parsePerms, permsJson, signEnvelope, verifySignature, freshTimestamp,
  normalizeEndpoint, jsonResponse, failResponse, postConnect, getConnect, nowIso
} from './connect_protocol.js';

const REQUEST_TTL_MS = 30 * 60 * 1000;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

function endpointFrom(request, override) {
  const saved = normalizeEndpoint(override);
  if (saved) return saved;
  try { return `${new URL(request.url).origin}/connect`; } catch { return ''; }
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

export async function ensureIdentity(env, request) {
  let row = null;
  try {
    row = await get(env, 'SELECT * FROM cx_connect_identity WHERE id = 1');
  } catch (error) {
    const msg = String(error?.message || error);
    if (/no such table/i.test(msg)) {
      return { ready: false, error: 'Connect App tables are not installed. Apply schema/migrate_connect_app.sql.' };
    }
    throw error;
  }
  if (!row) {
    row = {
      id: 1,
      application_id: applicationId('CONNECTX'),
      application_name: 'ConnectX',
      kind: 'gateway',
      endpoint_override: '',
      created_at: nowIso()
    };
    try { await insert(env, 'cx_connect_identity', row); }
    catch { row = await get(env, 'SELECT * FROM cx_connect_identity WHERE id = 1'); }
  }
  return { ready: true, ...row, connect_endpoint: endpointFrom(request, row.endpoint_override) };
}

export function publicIdentity(ident) {
  return {
    protocol: PROTOCOL,
    application_id: ident.application_id,
    application_name: ident.application_name || 'ConnectX',
    kind: 'gateway',
    connect_endpoint: ident.connect_endpoint,
    capabilities: ['sms:send', 'sms:status', 'sms:deliver']
  };
}

function publicConnection(row) {
  if (!row) return null;
  const online = row.remote_kind === 'android'
    ? !!(row.last_seen_at && (Date.now() - new Date(row.last_seen_at).getTime()) < 3 * 60 * 1000)
    : row.status === 'ACTIVE';
  return {
    connection_id: row.id,
    remote_application_id: row.remote_application_id,
    remote_application_name: row.remote_application_name,
    remote_endpoint: row.remote_kind === 'android' ? '' : row.remote_endpoint,
    remote_kind: row.remote_kind,
    display_name: row.display_name,
    device_name: row.device_name,
    sim_label: row.sim_label,
    app_version: row.app_version,
    permissions: parsePerms(row.permissions),
    status: row.status,
    connected: row.status === 'ACTIVE',
    online,
    connected_at: row.connected_at,
    disconnected_at: row.disconnected_at,
    last_seen_at: row.last_seen_at
  };
}

function publicRequest(row) {
  if (!row) return null;
  return {
    request_token: row.id,
    direction: row.direction,
    pairing_code: row.pairing_code,
    remote_application_id: row.remote_application_id,
    remote_application_name: row.remote_application_name,
    remote_endpoint: row.remote_kind === 'android' ? '' : row.remote_endpoint,
    remote_kind: row.remote_kind,
    display_name: row.display_name,
    requested_permissions: parsePerms(row.requested_permissions),
    status: row.status,
    connection_id: row.connection_id,
    created_at: row.created_at,
    expires_at: row.expires_at
  };
}

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    connection_id: row.connection_id,
    request_id: row.request_id,
    recipient: row.recipient,
    message: row.message,
    status: row.status,
    sim_used: row.sim_used,
    reason: row.reason,
    device_connection_id: row.device_connection_id,
    callback_status: row.callback_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    result_at: row.result_at,
    remote_name: row.remote_name || null
  };
}

async function operatorSession(env, request) {
  const payload = await verifyToken(bearerOf(request), env.SESSION_SECRET);
  if (!payload || !['owner', 'operator'].includes(payload.role)) return null;
  const op = await get(env, 'SELECT * FROM cx_operators WHERE id = ?', payload.id);
  if (!op || !bool(op.active)) return null;
  return op;
}

async function loadConnection(env, id) {
  return get(env, 'SELECT * FROM cx_connect_connections WHERE id = ?', id);
}

async function touch(env, id, extra = {}) {
  await update(env, 'cx_connect_connections', { last_seen_at: nowIso(), ...extra }, 'id = ?', id);
}

function hasPerm(conn, perm) {
  return parsePerms(conn?.permissions).includes(perm);
}

export async function releaseStale(env) {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  await update(env, 'cx_connect_jobs',
    { status: 'PENDING', device_connection_id: null, updated_at: nowIso() },
    "status = 'PROCESSING' AND updated_at < ?", cutoff).catch(() => {});
}

export async function callbackProduct(env, job) {
  const origin = await loadConnection(env, job.connection_id);
  if (!origin || origin.status !== 'ACTIVE' || !origin.remote_endpoint) {
    await update(env, 'cx_connect_jobs', { callback_status: 'SKIPPED', callback_error: 'Origin connection is not active.', updated_at: nowIso() }, 'id = ?', job.id);
    return { ok: false };
  }
  const ident = await ensureIdentity(env, { url: origin.remote_endpoint });
  const envelope = await signEnvelope({
    action: 'SMS_RESULT',
    applicationId: ident.application_id,
    connectionId: origin.id,
    secret: origin.shared_secret,
    payload: {
      request_id: job.request_id,
      status: job.status,
      sim_used: job.sim_used || '',
      timestamp: job.result_at || nowIso(),
      reason: job.reason || ''
    }
  });
  const res = await postConnect(origin.remote_endpoint, envelope);
  if (!res.httpOk || res.data?.ok === false) {
    await update(env, 'cx_connect_jobs', {
      callback_status: 'PENDING',
      callback_error: String(res.data?.error || 'Result callback failed').slice(0, 300),
      updated_at: nowIso()
    }, 'id = ?', job.id);
    return { ok: false, error: res.data?.error };
  }
  await update(env, 'cx_connect_jobs', { callback_status: 'DELIVERED', callback_error: null, updated_at: nowIso() }, 'id = ?', job.id);
  await touch(env, origin.id);
  return { ok: true };
}

export async function retryCallbacks(env) {
  const rows = await all(env, `
    SELECT * FROM cx_connect_jobs
    WHERE status IN ('SUCCESS','FAILED') AND (callback_status IS NULL OR callback_status = 'PENDING')
    ORDER BY updated_at ASC LIMIT 20
  `).catch(() => []);
  for (const job of rows) await callbackProduct(env, job);
}

async function signedConnection(env, envelope, { allowDisconnected = false } = {}) {
  if (!envelope?.connection_id || !envelope?.application_id) return { error: failResponse('connection_id and application_id are required.', 401, 'unauthorized') };
  if (!freshTimestamp(envelope.timestamp)) return { error: failResponse('Request timestamp is outside the allowed window.', 401, 'stale') };
  const conn = await loadConnection(env, envelope.connection_id);
  if (!conn) return { error: failResponse('Unknown connection.', 403, 'not_connected') };
  if (conn.status !== 'ACTIVE' && !allowDisconnected) return { error: failResponse('Connection is not active.', 403, 'not_connected') };
  if (conn.remote_application_id !== envelope.application_id) return { error: failResponse('Application ID does not match this connection.', 403, 'application_id') };
  if (!(await verifySignature(envelope, conn.shared_secret))) return { error: failResponse('Signature check failed.', 401, 'bad_signature') };
  return { conn };
}

async function acceptSms(env, conn, payload) {
  if (!hasPerm(conn, 'sms:send')) return failResponse('This connection does not have sms:send permission.', 403, 'permission');
  const requestId = str(payload.request_id, 80);
  const recipient = cleanPhone(payload.recipient);
  const message = str(payload.message, 1000);
  if (!requestId) return failResponse('request_id is required.', 400, 'request_id');
  if (!/^SMS-[A-Z0-9-]{4,40}$/i.test(requestId)) return failResponse('request_id must look like SMS-10001.', 400, 'request_id');
  if (!recipient) return failResponse('recipient phone is required.', 400, 'recipient');
  if (!message) return failResponse('message is required.', 400, 'message');
  const existing = await get(env, 'SELECT * FROM cx_connect_jobs WHERE connection_id = ? AND request_id = ?', conn.id, requestId);
  if (existing) {
    return jsonResponse({ ok: true, request_id: requestId, status: existing.status, duplicate: true });
  }
  const id = crypto.randomUUID();
  const row = {
    id,
    connection_id: conn.id,
    request_id: requestId,
    recipient,
    message,
    status: 'PENDING',
    meta: JSON.stringify({
      ...(payload.meta && typeof payload.meta === 'object' ? payload.meta : {}),
      shop_id: (payload.meta && payload.meta.shop_id) || payload.shop_id || ''
    }),
    callback_status: 'WAITING',
    created_at: nowIso(),
    updated_at: nowIso()
  };
  try {
    await insert(env, 'cx_connect_jobs', row);
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String(error?.message || error))) {
      const again = await get(env, 'SELECT * FROM cx_connect_jobs WHERE connection_id = ? AND request_id = ?', conn.id, requestId);
      return jsonResponse({ ok: true, request_id: requestId, status: again?.status || 'PENDING', duplicate: true });
    }
    throw error;
  }
  await touch(env, conn.id);
  await logActivity(env, { actorType: 'connect', actorId: conn.id, actorLabel: conn.display_name, action: 'accept SMS', entityType: 'sms', entityId: requestId, meta: { recipient } });
  return jsonResponse({ ok: true, request_id: requestId, status: 'PENDING', duplicate: false }, 201);
}

async function pullTasks(env, conn, payload) {
  if (!hasPerm(conn, 'sms:deliver')) return failResponse('This connection cannot deliver SMS.', 403, 'permission');
  await releaseStale(env);
  const limit = Math.min(8, Math.max(1, Number(payload.limit) || 5));
  await touch(env, conn.id, {
    device_name: str(payload.device_name || conn.device_name, 80),
    sim_label: str(payload.sim_label || conn.sim_label, 120),
    app_version: str(payload.app_version || conn.app_version, 40)
  });
  const jobs = await all(env, `
    SELECT * FROM cx_connect_jobs
    WHERE status = 'PENDING'
    ORDER BY created_at ASC
    LIMIT ?
  `, limit);
  const tasks = [];
  for (const job of jobs) {
    await update(env, 'cx_connect_jobs', {
      status: 'PROCESSING',
      device_connection_id: conn.id,
      updated_at: nowIso()
    }, "id = ? AND status = 'PENDING'", job.id);
    const fresh = await get(env, "SELECT * FROM cx_connect_jobs WHERE id = ? AND status = 'PROCESSING' AND device_connection_id = ?", job.id, conn.id);
    if (!fresh) continue;
    tasks.push({
      request_id: fresh.request_id,
      recipient: fresh.recipient,
      message: fresh.message,
      status: 'PROCESSING',
      created_at: fresh.created_at
    });
  }
  await retryCallbacks(env).catch(() => {});
  return jsonResponse({ ok: true, status: 'ACTIVE', tasks });
}

async function taskResult(env, conn, payload) {
  if (!hasPerm(conn, 'sms:deliver')) return failResponse('This connection cannot report SMS results.', 403, 'permission');
  const requestId = str(payload.request_id, 80);
  const status = String(payload.status || '').toUpperCase();
  if (!requestId) return failResponse('request_id is required.', 400, 'request_id');
  if (status !== 'SUCCESS' && status !== 'FAILED') return failResponse('status must be SUCCESS or FAILED.', 400, 'status');
  // Prefer the row this phone already claimed. Then an unassigned PENDING row
  // with the same Request ID, and only if that match is unique. Never complete
  // another product's PROCESSING job just because the Request ID collided.
  let exact = await get(env, `SELECT * FROM cx_connect_jobs WHERE request_id = ? AND device_connection_id = ? ORDER BY created_at DESC LIMIT 1`, requestId, conn.id);
  if (!exact) {
    const pending = await all(env, `SELECT * FROM cx_connect_jobs WHERE request_id = ? AND status = 'PENDING' AND (device_connection_id IS NULL OR device_connection_id = '')`, requestId);
    if (pending.length === 1) exact = pending[0];
  }
  if (!exact) return failResponse('Unknown Request ID.', 404, 'unknown_request');
  if (exact.device_connection_id && exact.device_connection_id !== conn.id && exact.status !== 'PENDING') {
    return failResponse('This task belongs to another phone.', 403, 'device');
  }
  if ((exact.status === 'SUCCESS' || exact.status === 'FAILED') && exact.status === status) {
    return jsonResponse({ ok: true, request_id: requestId, status, duplicate: true });
  }
  if (exact.status === 'SUCCESS' || exact.status === 'FAILED') {
    return jsonResponse({ ok: true, request_id: requestId, status: exact.status, duplicate: true });
  }
  const sim = str(payload.sim_used, 120);
  const reason = status === 'FAILED' ? str(payload.reason || 'FAILED', 400) : '';
  const resultAt = payload.timestamp || nowIso();
  await update(env, 'cx_connect_jobs', {
    status,
    sim_used: sim,
    reason,
    result_at: resultAt,
    device_connection_id: conn.id,
    callback_status: 'PENDING',
    updated_at: nowIso()
  }, 'id = ?', exact.id);
  await touch(env, conn.id, { sim_label: sim || conn.sim_label });
  const updated = await get(env, 'SELECT * FROM cx_connect_jobs WHERE id = ?', exact.id);
  await callbackProduct(env, updated);
  await logActivity(env, { actorType: 'android', actorId: conn.id, actorLabel: conn.display_name, action: 'SMS ' + status, entityType: 'sms', entityId: requestId, meta: { sim, reason } });
  return jsonResponse({ ok: true, request_id: requestId, status });
}

async function handleHandshake(env, request, envelope) {
  const p = envelope.payload || {};
  const token = str(p.request_token, 80);
  const code = str(p.pairing_code, 20);
  const connId = str(p.connection_id, 40);
  if (!token || !code || !connId || !p.shared_secret) return failResponse('Handshake is incomplete.', 400, 'handshake');
  const pending = await get(env, 'SELECT * FROM cx_connect_requests WHERE id = ?', token);
  if (!pending || pending.direction !== 'outbound') return failResponse('Unknown connection request.', 404, 'unknown_request');
  if (pending.pairing_code !== code) return failResponse('Pairing code does not match.', 403, 'pairing_code');
  if (pending.status === 'CONSUMED' && pending.connection_id === connId) {
    const ident = await ensureIdentity(env, request);
    return jsonResponse({ ok: true, status: 'ACTIVE', connection_id: connId, ...publicIdentity(ident) });
  }
  if (pending.status !== 'PENDING_APPROVAL') return failResponse('This connection request is no longer waiting.', 409, 'not_pending');
  const remoteEndpoint = normalizeEndpoint(p.connect_endpoint);
  if (!remoteEndpoint) return failResponse('Remote Connect Endpoint is invalid.', 400, 'endpoint');
  await insert(env, 'cx_connect_connections', {
    id: connId,
    remote_application_id: envelope.application_id,
    remote_application_name: str(p.application_name || 'Remote app', 80),
    remote_endpoint: remoteEndpoint,
    remote_kind: str(p.kind || 'product', 40),
    permissions: permsJson(p.permissions || pending.requested_permissions),
    shared_secret: String(p.shared_secret),
    status: 'ACTIVE',
    display_name: pending.display_name || p.application_name || 'Connected app',
    connected_at: nowIso(),
    last_seen_at: nowIso(),
    created_at: nowIso()
  });
  await update(env, 'cx_connect_requests', {
    status: 'CONSUMED', connection_id: connId,
    remote_application_id: envelope.application_id,
    remote_application_name: str(p.application_name || '', 80),
    remote_endpoint: remoteEndpoint
  }, 'id = ?', token);
  const ident = await ensureIdentity(env, request);
  return jsonResponse({ ok: true, status: 'ACTIVE', connection_id: connId, application_id: ident.application_id, application_name: ident.application_name, connect_endpoint: ident.connect_endpoint });
}

async function pushStatus(env, ident, conn, status) {
  if (!conn?.remote_endpoint || !conn.shared_secret) return;
  const envelope = await signEnvelope({
    action: 'SET_STATUS', applicationId: ident.application_id, connectionId: conn.id,
    secret: conn.shared_secret, payload: { status }
  });
  await postConnect(conn.remote_endpoint, envelope).catch(() => {});
}

async function applyRemoteStatus(env, envelope) {
  const conn = await loadConnection(env, envelope.connection_id);
  if (!conn) return failResponse('Unknown connection.', 403, 'not_connected');
  if (conn.remote_application_id && conn.remote_application_id !== envelope.application_id) return failResponse('Application ID does not match this connection.', 403, 'application_id');
  if (!(await verifySignature(envelope, conn.shared_secret))) return failResponse('Signature check failed.', 401, 'bad_signature');
  const ident = await ensureIdentity(env, { url: conn.remote_endpoint || 'https://connectxweb.pages.dev/connect' });
  return applyConnectionStatus(env, ident, null, conn.id, envelope.payload?.status, { notify: false });
}

async function applyConnectionStatus(env, ident, op, id, status, { notify = true } = {}) {
  const conn = await loadConnection(env, id);
  if (!conn) return failResponse('Connection not found.', 404);
  const next = String(status || '').toUpperCase();
  if (!['ACTIVE', 'PAUSED', 'DISCONNECTED', 'DELETED'].includes(next)) return failResponse('Choose active, pause, disconnect, or delete.', 400);
  if (notify) await pushStatus(env, ident, conn, next);
  if (next === 'DELETED') {
    await run(env, 'DELETE FROM cx_connect_connections WHERE id = ?', id);
  } else {
    await update(env, 'cx_connect_connections', {
      status: next,
      disconnected_at: next === 'DISCONNECTED' ? nowIso() : null
    }, 'id = ?', id);
  }
  if (op) await logActivity(env, { actorType: 'operator', actorId: op.id, actorLabel: op.name, action: next.toLowerCase(), entityType: 'connection', entityId: id });
  return jsonResponse({ ok: true, status: next });
}

export async function handleConnect(request, env) {
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return jsonResponse({ ok: true });
  const ident = await ensureIdentity(env, request);
  if (!ident.ready) return failResponse(ident.error, 503, 'not_ready');
  if (method === 'GET') return jsonResponse({ ok: true, ...publicIdentity(ident) });
  if (method !== 'POST') return failResponse('Use POST.', 405, 'method');
  const envelope = await readJson(request);
  if (envelope.protocol && envelope.protocol !== PROTOCOL) return failResponse('Unsupported Connect protocol.', 400, 'protocol');
  const action = String(envelope.action || '').toUpperCase();

  if (action === 'CONNECT_REQUEST') {
    const p = envelope.payload || {};
    const token = str(p.request_token, 90);
    const kind = str(p.kind || 'product', 40).toLowerCase();
    const endpoint = kind === 'android' ? '' : normalizeEndpoint(p.connect_endpoint);
    if (!envelope.application_id || !token) return failResponse('Connection request is incomplete.', 400, 'request');
    if (kind !== 'android' && !endpoint) return failResponse('connect_endpoint is required.', 400, 'endpoint');
    const existing = await get(env, 'SELECT id, status FROM cx_connect_requests WHERE id = ?', token);
    if (!existing) {
      await insert(env, 'cx_connect_requests', {
        id: token,
        direction: 'inbound',
        pairing_code: str(p.pairing_code, 20),
        remote_application_id: envelope.application_id,
        remote_application_name: str(p.application_name || (kind === 'android' ? 'Android phone' : 'Remote app'), 80),
        remote_endpoint: endpoint,
        remote_kind: kind,
        display_name: str(p.display_name || p.application_name || 'Connect request', 80),
        requested_permissions: permsJson(p.requested_permissions || (kind === 'android' ? ['sms:deliver'] : ['sms:send'])),
        status: 'PENDING_APPROVAL',
        created_at: nowIso(),
        expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString()
      });
      await logActivity(env, { actorType: 'connect', actorLabel: p.display_name || envelope.application_id, action: 'connection request', entityType: 'connect_request', entityId: token, meta: { kind, pairing_code: p.pairing_code } });
    }
    return jsonResponse({ ok: true, status: existing?.status === 'APPROVED' ? 'APPROVED' : 'PENDING_APPROVAL', request_token: token, pairing_code: p.pairing_code || null });
  }

  if (action === 'POLL_PAIRING') {
    const token = str(envelope.payload?.request_token, 90);
    if (!token || token !== str(envelope.payload?.request_token, 90)) return failResponse('request_token is required.', 401, 'unauthorized');
    const pending = await get(env, 'SELECT * FROM cx_connect_requests WHERE id = ?', token);
    if (!pending) return failResponse('Unknown connection request.', 404, 'unknown_request');
    if (pending.remote_application_id && envelope.application_id && pending.remote_application_id !== envelope.application_id) {
      return failResponse('Application ID does not match this request.', 403, 'application_id');
    }
    if (pending.status === 'REJECTED' || pending.status === 'CANCELLED') return jsonResponse({ ok: true, status: pending.status });
    if (pending.status !== 'APPROVED' && pending.status !== 'CONSUMED') return jsonResponse({ ok: true, status: 'PENDING_APPROVAL', pairing_code: pending.pairing_code });
    let handshake = null;
    try { handshake = pending.handshake_json ? JSON.parse(pending.handshake_json) : null; } catch { handshake = null; }
    if (!handshake) return jsonResponse({ ok: true, status: 'PENDING_APPROVAL' });
    return jsonResponse({ ok: true, status: 'ACTIVE', handshake });
  }

  if (action === 'HANDSHAKE') return handleHandshake(env, request, envelope);
  if (action === 'SET_STATUS') return applyRemoteStatus(env, envelope);

  const signed = await signedConnection(env, envelope);
  if (signed.error) return signed.error;
  const conn = signed.conn;
  const payload = envelope.payload || {};

  if (action === 'PING') {
    await touch(env, conn.id);
    return jsonResponse({ ok: true, status: 'ACTIVE', application_id: ident.application_id, application_name: 'ConnectX', connect_endpoint: ident.connect_endpoint });
  }
  if (action === 'SEND_SMS') return acceptSms(env, conn, payload);
  if (action === 'CANCEL_SMS') {
    const requestId = str(payload.request_id, 80);
    const job = await get(env, 'SELECT * FROM cx_connect_jobs WHERE connection_id = ? AND request_id = ?', conn.id, requestId);
    if (!job) return jsonResponse({ ok: true, cancelled: false, reason: 'not_found' });
    if (job.status !== 'PENDING') return jsonResponse({ ok: true, cancelled: false, status: job.status });
    await update(env, 'cx_connect_jobs', { status: 'FAILED', reason: 'Cancelled by sender', result_at: nowIso(), updated_at: nowIso(), callback_status: 'SKIPPED' }, 'id = ? AND status = ?', job.id, 'PENDING');
    return jsonResponse({ ok: true, cancelled: true, request_id: requestId, status: 'FAILED' });
  }
  if (action === 'PULL_TASKS') return pullTasks(env, conn, payload);
  if (action === 'TASK_RESULT') return taskResult(env, conn, payload);
  if (action === 'SIM_UPDATE') {
    const label = str(payload.sim_label, 120);
    await touch(env, conn.id, { sim_label: label, device_name: str(payload.device_name || conn.device_name, 80) });
    return jsonResponse({ ok: true, sim_label: label });
  }
  if (action === 'ACTIVITY') {
    const rows = await all(env, `
      SELECT request_id, recipient, message, status, reason, sim_used, created_at, result_at
      FROM cx_connect_jobs
      WHERE device_connection_id = ? OR connection_id = ?
      ORDER BY created_at DESC LIMIT 80
    `, conn.id, conn.id);
    const counts = { SUCCESS: 0, FAILED: 0, PENDING: 0, PROCESSING: 0 };
    const since = new Date(); since.setHours(0, 0, 0, 0);
    for (const row of rows) {
      if (row.created_at && row.created_at >= since.toISOString() && counts[row.status] != null) counts[row.status]++;
    }
    return jsonResponse({
      ok: true,
      sent: counts.SUCCESS,
      failed: counts.FAILED,
      pending: counts.PENDING + counts.PROCESSING,
      lastActivity: rows[0]?.result_at || rows[0]?.created_at || null,
      items: rows.map(r => ({
        id: r.request_id,
        to_phone: r.recipient,
        message_body: r.message,
        status: r.status,
        error_message: r.reason,
        sim_used: r.sim_used,
        created_at: r.created_at,
        sent_at: r.result_at
      }))
    });
  }
  if (action === 'DISCONNECT') {
    await update(env, 'cx_connect_connections', { status: 'DISCONNECTED', disconnected_at: nowIso() }, 'id = ?', conn.id);
    return jsonResponse({ ok: true, status: 'DISCONNECTED', connection_id: conn.id });
  }
  return failResponse('Unknown Connect action.', 400, 'action');
}

async function approveRequest(env, request, op, token, body) {
  const pending = await get(env, 'SELECT * FROM cx_connect_requests WHERE id = ?', token);
  if (!pending) return { error: 'Connection request not found.', status: 404 };
  if (pending.status !== 'PENDING_APPROVAL') return { error: 'This request is not waiting for approval.', status: 409 };
  if (pending.expires_at && Date.parse(pending.expires_at) < Date.now()) {
    await update(env, 'cx_connect_requests', { status: 'EXPIRED' }, 'id = ?', token);
    return { error: 'This request expired. Ask them to send a new one.', status: 410 };
  }
  const ident = await ensureIdentity(env, request);
  const connId = connectionId();
  const secret = sharedSecret();
  const requested = parsePerms(body.permissions?.length ? body.permissions : pending.requested_permissions);
  const permissions = requested.length ? requested : (pending.remote_kind === 'android' ? ['sms:deliver'] : ['sms:send', 'sms:status']);
  const handshake = {
    connection_id: connId,
    permissions,
    shared_secret: secret,
    remote_application_id: ident.application_id,
    remote_application_name: 'ConnectX',
    remote_connect_endpoint: ident.connect_endpoint
  };
  if (pending.remote_kind === 'android' || !pending.remote_endpoint) {
    await insert(env, 'cx_connect_connections', {
      id: connId,
      remote_application_id: pending.remote_application_id,
      remote_application_name: pending.remote_application_name || 'Android phone',
      remote_endpoint: '',
      remote_kind: 'android',
      permissions: permsJson(permissions),
      shared_secret: secret,
      status: 'ACTIVE',
      display_name: pending.display_name || 'Android phone',
      device_name: pending.display_name || 'Android phone',
      connected_at: nowIso(),
      created_at: nowIso()
    });
    await update(env, 'cx_connect_requests', {
      status: 'APPROVED', connection_id: connId, handshake_json: JSON.stringify(handshake)
    }, 'id = ?', token);
  } else {
    const call = await postConnect(pending.remote_endpoint, {
      protocol: PROTOCOL,
      action: 'HANDSHAKE',
      application_id: ident.application_id,
      connection_id: '',
      timestamp: nowIso(),
      nonce: requestToken().slice(4, 20),
      payload: {
        request_token: pending.id,
        pairing_code: pending.pairing_code,
        connection_id: connId,
        permissions,
        shared_secret: secret,
        application_name: 'ConnectX',
        connect_endpoint: ident.connect_endpoint,
        kind: 'gateway'
      }
    });
    if (!call.httpOk || call.data?.ok === false || call.data?.status !== 'ACTIVE') {
      return { error: call.data?.error || 'The other app did not confirm the handshake. Check that its Connect Endpoint is publicly reachable.', status: 502 };
    }
    await insert(env, 'cx_connect_connections', {
      id: connId,
      remote_application_id: call.data.application_id || pending.remote_application_id,
      remote_application_name: call.data.application_name || pending.remote_application_name || 'Remote app',
      remote_endpoint: normalizeEndpoint(call.data.connect_endpoint) || pending.remote_endpoint,
      remote_kind: pending.remote_kind || 'product',
      permissions: permsJson(permissions),
      shared_secret: secret,
      status: 'ACTIVE',
      display_name: pending.display_name || call.data.application_name || 'Connected app',
      connected_at: nowIso(),
      last_seen_at: nowIso(),
      created_at: nowIso()
    });
    await update(env, 'cx_connect_requests', { status: 'CONSUMED', connection_id: connId }, 'id = ?', token);
  }
  await logActivity(env, { actorType: 'operator', actorId: op.id, actorLabel: op.name, action: 'approve connection', entityType: 'connection', entityId: connId, meta: { request: token } });
  const saved = await loadConnection(env, connId);
  return { connection: publicConnection(saved) };
}

export async function connectControlRoutes(ctx) {
  const { env, request, path, method } = ctx;
  if (!path.startsWith('control/connect')) return null;
  const op = await operatorSession(env, request);
  if (!op) return failResponse('Sign in required.', 401, 'unauthorized');
  const ident = await ensureIdentity(env, request);
  if (!ident.ready) return failResponse(ident.error, 503, 'not_ready');
  const body = await readJson(request);

  if (path === 'control/connect' && method === 'GET') {
    await releaseStale(env);
    const [connections, requests, jobs, counts] = await Promise.all([
      all(env, 'SELECT * FROM cx_connect_connections ORDER BY created_at DESC'),
      all(env, "SELECT * FROM cx_connect_requests ORDER BY created_at DESC LIMIT 40"),
      all(env, `
        SELECT j.*, c.display_name AS remote_name
        FROM cx_connect_jobs j
        LEFT JOIN cx_connect_connections c ON c.id = j.connection_id
        ORDER BY j.created_at DESC LIMIT 40
      `),
      all(env, 'SELECT status, COUNT(*) AS n FROM cx_connect_jobs GROUP BY status')
    ]);
    const tally = Object.fromEntries((counts || []).map(r => [r.status, Number(r.n)]));
    const pub = (connections || []).map(publicConnection);
    const phones = await all(env, `SELECT last_seen_at, status FROM cx_phone_devices WHERE status != 'disconnected'`).catch(() => []);
    const phoneOnline = (phones || []).filter(p => p.last_seen_at && Date.now() - new Date(p.last_seen_at).getTime() < 3 * 60 * 1000).length;
    return jsonResponse({
      ready: true,
      identity: publicIdentity(ident),
      endpoint_override: ident.endpoint_override || '',
      connections: pub,
      requests: (requests || []).filter(r => r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED').map(publicRequest),
      recent_requests: (requests || []).map(publicRequest),
      jobs: (jobs || []).map(publicJob),
      counts: {
        pending: tally.PENDING || 0,
        processing: tally.PROCESSING || 0,
        success: tally.SUCCESS || 0,
        failed: tally.FAILED || 0
      },
      android_online: phoneOnline,
      products_connected: pub.filter(c => c.remote_kind !== 'android' && c.connected).length
    });
  }

  if (path === 'control/connect/endpoint' && method === 'POST') {
    const endpoint = body.endpoint ? normalizeEndpoint(body.endpoint) : '';
    if (body.endpoint && !endpoint) return failResponse('Enter a valid Connect Endpoint.', 400);
    await update(env, 'cx_connect_identity', { endpoint_override: endpoint }, 'id = 1');
    const next = await ensureIdentity(env, request);
    return jsonResponse({ ok: true, identity: publicIdentity(next) });
  }

  if (path === 'control/connect/request' && method === 'POST') {
    const remote = normalizeEndpoint(body.remote_endpoint);
    if (!remote) return failResponse('Paste the other app’s Connect Endpoint.', 400);
    const probe = await getConnect(remote);
    if (!probe.httpOk || probe.data?.protocol !== PROTOCOL) return failResponse(probe.data?.error || 'That address did not answer as a Connect App.', 502);
    const token = requestToken();
    const code = pairingCode();
    const permissions = parsePerms(body.permissions?.length ? body.permissions : ['sms:send']);
    await insert(env, 'cx_connect_requests', {
      id: token, direction: 'outbound', pairing_code: code,
      remote_application_id: probe.data.application_id || null,
      remote_application_name: probe.data.application_name || 'Remote app',
      remote_endpoint: remote, remote_kind: probe.data.kind || 'product',
      display_name: str(body.display_name || 'ConnectX', 80),
      requested_permissions: permsJson(permissions),
      status: 'PENDING_APPROVAL', created_at: nowIso(),
      expires_at: new Date(Date.now() + REQUEST_TTL_MS).toISOString()
    });
    const sent = await postConnect(remote, {
      protocol: PROTOCOL, action: 'CONNECT_REQUEST', application_id: ident.application_id,
      connection_id: '', timestamp: nowIso(), nonce: requestToken().slice(4, 20),
      payload: {
        application_name: 'ConnectX', kind: 'gateway', connect_endpoint: ident.connect_endpoint,
        display_name: str(body.display_name || 'ConnectX', 80),
        requested_permissions: permissions, pairing_code: code, request_token: token
      }
    });
    if (!sent.httpOk || sent.data?.ok === false) return failResponse(sent.data?.error || 'The other app did not accept the request.', 502);
    return jsonResponse({ ok: true, status: 'PENDING_APPROVAL', pairing_code: code, remote_application_name: probe.data.application_name, request_token: token }, 201);
  }

  const approve = path.match(/^control\/connect\/requests\/([^/]+)\/approve$/);
  if (approve && method === 'POST') {
    const result = await approveRequest(env, request, op, decodeURIComponent(approve[1]), body);
    if (result.error) return failResponse(result.error, result.status || 400);
    return jsonResponse({ ok: true, status: 'ACTIVE', connection: result.connection });
  }
  const reject = path.match(/^control\/connect\/requests\/([^/]+)\/reject$/);
  if (reject && method === 'POST') {
    await update(env, 'cx_connect_requests', { status: 'REJECTED' }, 'id = ?', decodeURIComponent(reject[1]));
    return jsonResponse({ ok: true, status: 'REJECTED' });
  }
  const statusRoute = path.match(/^control\/connect\/connections\/([^/]+)\/status$/);
  if (statusRoute && method === 'POST') {
    return applyConnectionStatus(env, ident, op, decodeURIComponent(statusRoute[1]), body.status);
  }
  const disc = path.match(/^control\/connect\/connections\/([^/]+)\/disconnect$/);
  if (disc && method === 'POST') {
    const id = decodeURIComponent(disc[1]);
    const conn = await loadConnection(env, id);
    if (!conn) return failResponse('Connection not found.', 404);
    if (conn.status === 'ACTIVE' && conn.remote_endpoint) {
      const envelope = await signEnvelope({
        action: 'DISCONNECT', applicationId: ident.application_id, connectionId: conn.id, secret: conn.shared_secret,
        payload: { reason: 'Disconnected by ConnectX administrator' }
      });
      await postConnect(conn.remote_endpoint, envelope);
    }
    await update(env, 'cx_connect_connections', { status: 'DISCONNECTED', disconnected_at: nowIso() }, 'id = ?', id);
    await logActivity(env, { actorType: 'operator', actorId: op.id, actorLabel: op.name, action: 'disconnect', entityType: 'connection', entityId: id });
    return jsonResponse({ ok: true, status: 'DISCONNECTED' });
  }
  const ping = path.match(/^control\/connect\/connections\/([^/]+)\/ping$/);
  if (ping && method === 'POST') {
    const conn = await loadConnection(env, decodeURIComponent(ping[1]));
    if (!conn || conn.status !== 'ACTIVE') return failResponse('Connection is not active.', 409);
    if (!conn.remote_endpoint) return jsonResponse({ ok: true, status: conn.last_seen_at ? 'ACTIVE' : 'WAITING', note: 'Android phones check in on their own. Last seen: ' + (conn.last_seen_at || 'never') });
    const envelope = await signEnvelope({ action: 'PING', applicationId: ident.application_id, connectionId: conn.id, secret: conn.shared_secret, payload: {} });
    const res = await postConnect(conn.remote_endpoint, envelope);
    if (!res.httpOk || res.data?.ok === false) return failResponse(res.data?.error || 'Ping failed.', 502);
    await touch(env, conn.id);
    return jsonResponse({ ok: true, status: 'ACTIVE', remote: { application_id: res.data.application_id, application_name: res.data.application_name } });
  }
  if (path === 'control/connect/jobs' && method === 'GET') {
    const status = str(new URL(request.url).searchParams.get('status') || '', 20);
    const connection = str(new URL(request.url).searchParams.get('connection') || '', 80);
    const where = [];
    const binds = [];
    if (status) { where.push('j.status = ?'); binds.push(status); }
    if (connection) { where.push('j.connection_id = ?'); binds.push(connection); }
    const rows = await all(env, `
      SELECT j.*, c.display_name AS remote_name, c.remote_application_name
      FROM cx_connect_jobs j
      LEFT JOIN cx_connect_connections c ON c.id = j.connection_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY j.created_at DESC LIMIT 200
    `, ...binds);
    return jsonResponse({ items: rows.map(publicJob) });
  }
  const retry = path.match(/^control\/connect\/jobs\/([^/]+)\/retry-callback$/);
  if (retry && method === 'POST') {
    const job = await get(env, 'SELECT * FROM cx_connect_jobs WHERE id = ?', decodeURIComponent(retry[1]));
    if (!job) return failResponse('Job not found.', 404);
    const res = await callbackProduct(env, job);
    if (!res.ok) return failResponse(res.error || 'Callback failed.', 502);
    return jsonResponse({ ok: true });
  }
  return failResponse('Unknown Connect App route.', 404);
}
