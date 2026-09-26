/* =====================================================================
   ConnectX Device API — the ONLY backend the ConnectX Android gateway
   talks to. There is no EMS involvement anywhere in this file.

   Auth models:
   · Operator token (HMAC signed, from device/auth/login) — used during
     sign-in and workspace selection, same UX the phone app already has.
   · Device token  (opaque `cxd_...`, SHA-256 hash stored in cx_devices)
     — used by a paired gateway for claim/report/stats/emails.
   · Pairing code  (generated on the control website) — alternative,
     account-free pairing for a phone.

   JSON response shapes intentionally mirror the previous gateway so the
   Android client is a thin re-point, while all data now lives in
   ConnectX's own D1 database.
   ===================================================================== */
import { all, get, insert, update, parseJson } from './db.js';
import {
  json, fail, uuid, nowIso, str, bool, cleanPhone, isUuid, dayStart, onlineOf,
  signToken, verifyToken, bearerOf, hashPassword, checkPassword, sha256,
  deviceToken as newDeviceToken, pairingCode
} from './core.js';
import { logActivity } from './audit.js';
import { dispatchWebhook } from './webhook.js';

const OPERATOR_TTL = 60 * 60 * 8;          // 8h operator sessions
const DEVICE_TTL = 60 * 60 * 24 * 400;     // device tokens: ~13 months
const EMAIL_PAGE_SIZE = 30;

/* ---------- public shapes ---------- */
export function publicOperator(o) {
  if (!o) return null;
  return {
    id: o.id,
    admin_code: o.operator_code || null,   // legacy key kept for the phone app
    name: o.name || '',
    email: o.email || '',
    phone: o.phone || '',
    address: o.address || '',
    role: o.role || 'operator',
    active: bool(o.active),
    created_at: o.created_at || null
  };
}

export function publicWorkspace(w) {
  if (!w) return null;
  return { id: w.id, name: w.name, address: w.address || '', phone: w.phone || '', code: w.code || '', shop_code: w.code || '' };
}

export function publicDevice(d) {
  if (!d) return null;
  return {
    id: d.id,
    device_public_id: d.device_public_id,
    device_name: d.device_name,
    android_version: d.android_version,
    app_version: d.app_version || null,
    sim_subscription_id: d.sim_subscription_id,
    sim_carrier: d.sim_carrier,
    phone_number: d.phone_number,
    status: d.status,
    is_primary: bool(d.is_primary),
    last_seen: d.last_seen,
    created_at: d.created_at,
    store_id: d.workspace_id,              // legacy key kept for the phone app
    workspace_id: d.workspace_id
  };
}

export function publicEmail(row, detail = false) {
  if (!row) return null;
  const addresses = v => { const a = parseJson(v, []); return Array.isArray(a) ? a.map(String) : []; };
  return {
    id: row.id,
    subject: row.subject || '',
    from_email: row.from_email || '',
    to_emails: addresses(row.to_emails),
    cc_emails: addresses(row.cc_emails),
    recipient_type: row.recipient_type || '',
    status: row.status || 'queued',
    error_message: row.error_message || null,
    created_at: row.created_at,
    sent_at: row.sent_at || null,
    ...(detail ? {
      bcc_emails: addresses(row.bcc_emails),
      custom_body: row.custom_body || '',
      body_html: row.body_html || ''
    } : {})
  };
}

/* ---------- auth helpers ---------- */
export async function operatorSession(env, request) {
  const payload = await verifyToken(bearerOf(request), env.SESSION_SECRET);
  if (!payload || !['owner', 'operator'].includes(payload.role)) return null;
  const op = await get(env, 'SELECT * FROM cx_operators WHERE id = ?', payload.id);
  if (!op || !bool(op.active)) return null;
  return op;
}

export async function deviceSession(env, request) {
  const token = bearerOf(request);
  if (!token.startsWith('cxd_')) return null;
  const hash = await sha256(token);
  const device = await get(env, 'SELECT * FROM cx_devices WHERE token_hash = ?', hash);
  if (!device || device.status === 'revoked') return null;
  return device;
}

async function touchDevice(env, deviceId, patch = {}) {
  await update(env, 'cx_devices', { last_seen: nowIso(), updated_at: nowIso(), ...patch }, 'id = ?', deviceId).catch(() => {});
}

async function workspaceFor(env, device) {
  return get(env, 'SELECT * FROM cx_workspaces WHERE id = ?', device.workspace_id);
}

async function operatorFor(env, device) {
  if (!device.operator_id) return null;
  return get(env, 'SELECT * FROM cx_operators WHERE id = ?', device.operator_id);
}

/* ---------- device registration / pairing (shared) ---------- */
async function createDevice(env, { workspace, operator, b, viaPairing = false }) {
  const existing = await all(env,
    "SELECT id FROM cx_devices WHERE workspace_id = ? AND status != 'revoked'", workspace.id);
  const isPrimary = existing.length === 0 || bool(b.isPrimary);
  if (isPrimary) {
    await update(env, 'cx_devices', { is_primary: 0 }, 'workspace_id = ? AND is_primary = 1', workspace.id).catch(() => {});
  }
  const id = uuid();
  const token = newDeviceToken();
  const row = {
    id,
    workspace_id: workspace.id,
    operator_id: operator ? operator.id : null,
    device_public_id: 'CX-' + id.replaceAll('-', '').slice(0, 10).toUpperCase(),
    device_name: str(b.deviceName || b.device_name || 'Android gateway', 120),
    android_version: str(b.androidVersion || b.android_version || '', 40) || null,
    app_version: str(b.appVersion || b.app_version || '', 40) || null,
    sim_subscription_id: b.simSubscriptionId != null ? String(b.simSubscriptionId) : null,
    sim_carrier: str(b.simCarrier || b.sim_carrier || '', 80) || null,
    phone_number: str(b.phoneNumber || b.phone_number || '', 32) || null,
    status: 'pending_test',
    is_primary: isPrimary ? 1 : 0,
    token_hash: await sha256(token),
    last_seen: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso()
  };
  await insert(env, 'cx_devices', row);
  await logActivity(env, {
    actorType: operator ? 'operator' : 'system',
    actorId: operator ? operator.id : null,
    actorLabel: operator ? operator.name : (viaPairing ? 'Pairing code' : 'System'),
    action: viaPairing ? 'pair gateway device' : 'register gateway device',
    entityType: 'device', entityId: id,
    meta: { device_name: row.device_name, workspace: workspace.name, phone: row.phone_number }
  });
  return { device: row, token };
}

/* ===================================================================== */
export async function deviceRoutes(ctx) {
  const { env, request, path, method, url } = ctx;
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  /* ---------------- operator sign-in (phone app login screen) ---------- */
  if (path === 'device/auth/login' && method === 'POST') {
    const b = await body();
    const email = str(b.email || '').toLowerCase();
    const op = await get(env, 'SELECT * FROM cx_operators WHERE email = ?', email);
    if (!op) return fail('Wrong email or password.', 401);
    if (!bool(op.active)) return fail('This ConnectX account is deactivated. Contact the platform owner.', 403);
    if (!await checkPassword(b.password || '', op.password_hash)) return fail('Wrong email or password.', 401);
    await update(env, 'cx_operators', { last_login_at: nowIso() }, 'id = ?', op.id).catch(() => {});
    const token = await signToken(
      { id: op.id, role: op.role, email: op.email, exp: Math.floor(Date.now() / 1000) + OPERATOR_TTL },
      env.SESSION_SECRET);
    return json({ token, user: publicOperator(op), role: 'admin' }); // legacy role key kept for the phone app
  }

  if (path === 'device/auth/profile' && method === 'GET') {
    const op = await operatorSession(env, request);
    if (!op) return fail('Please sign in.', 401);
    return json(publicOperator(op));
  }

  /* ---------------- pairing code (account-free phone pairing) ---------- */
  if (path === 'device/pair' && method === 'POST') {
    const b = await body();
    // Accept the code with or without its dash (4F7K-9Q2M / 4F7K9Q2M).
    let code = str(b.code || b.pairingCode || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const digits = code.replace(/-/g, '');
    if (digits.length === 8) code = `${digits.slice(0, 4)}-${digits.slice(4)}`;
    if (!code) return fail('Pairing code is required.', 400);
    const pair = await get(env, 'SELECT * FROM cx_pairing_codes WHERE code = ?', code);
    if (!pair || pair.used_at) return fail('This pairing code was already used. Generate a new one in ConnectX Control.', 404);
    if (new Date(pair.expires_at).getTime() < Date.now())
      return fail('This pairing code expired. Generate a new one in ConnectX Control.', 410);
    const workspace = await get(env, 'SELECT * FROM cx_workspaces WHERE id = ?', pair.workspace_id);
    if (!workspace || workspace.status !== 'active') return fail('That workspace is not active.', 404);
    const { device, token } = await createDevice(env, { workspace, operator: null, b, viaPairing: true });
    await update(env, 'cx_pairing_codes', { used_at: nowIso(), device_id: device.id }, 'id = ?', pair.id).catch(() => {});
    return json({
      device: publicDevice(device),
      deviceToken: token,
      shop: publicWorkspace(workspace),          // legacy key kept for the phone app
      workspace: publicWorkspace(workspace),
      administrator: null
    }, 201);
  }

  /* ---------------- workspace list (phone app "shops" screen) ---------- */
  if (path === 'device/workspaces' && method === 'GET') {
    const op = await operatorSession(env, request);
    if (!op) return fail('ConnectX sign-in required.', 403);
    const workspaces = await all(env, "SELECT * FROM cx_workspaces WHERE status = 'active' ORDER BY created_at DESC");
    const devices = await all(env,
      "SELECT * FROM cx_devices WHERE operator_id = ? AND status != 'revoked'", op.id);
    const connected = new Set(devices.map(d => d.workspace_id));
    return json({
      administrator: publicOperator(op),
      shops: workspaces.map(w => ({ ...publicWorkspace(w), connected: connected.has(w.id) })) // legacy key kept for the phone app
    });
  }

  /* ---------------- device registration (phone app setup) -------------- */
  if (path === 'device/register' && method === 'POST') {
    const op = await operatorSession(env, request);
    if (!op) return fail('ConnectX sign-in required.', 403);
    const b = await body();
    const wsId = str(b.storeId || b.workspaceId || b.workspace_id || '');
    if (!wsId) return fail('Workspace is required.', 400);
    const workspace = await get(env, "SELECT * FROM cx_workspaces WHERE id = ? AND status = 'active'", wsId);
    if (!workspace) return fail('Workspace not found.', 404);
    const { device, token } = await createDevice(env, { workspace, operator: op, b });
    return json({
      device: publicDevice(device),
      deviceToken: token,
      shop: publicWorkspace(workspace),          // legacy key kept for the phone app
      administrator: publicOperator(op)
    }, 201);
  }

  /* =====================================================================
     Everything below requires a paired-device token.
     ===================================================================== */
  const device = await deviceSession(env, request);
  if (!device) {
    const isDevicePath = path.startsWith('device/');
    if (isDevicePath) return fail('Device not connected. Pair this phone again in ConnectX Control.', 403);
    return null;
  }
  const workspace = await workspaceFor(env, device);
  if (!workspace) return fail('The workspace for this device was removed.', 403);
  if (workspace.status !== 'active') return fail('This workspace is paused. Resume it in ConnectX Control.', 403);

  if (path === 'device/me' && method === 'GET') {
    const op = await operatorFor(env, device);
    const wsDevices = await all(env,
      "SELECT workspace_id FROM cx_devices WHERE status != 'revoked' AND operator_id = ?", device.operator_id || '');
    return json({
      device: publicDevice(device),
      shop: publicWorkspace(workspace),
      workspace: publicWorkspace(workspace),
      administrator: publicOperator(op),
      connectedStoreIds: [...new Set(wsDevices.map(x => x.workspace_id))]
    });
  }

  if (path === 'device/heartbeat' && method === 'POST') {
    const b = await body();
    const patch = { status: device.status === 'pending_test' ? 'pending_test' : 'active' };
    if (b.androidVersion) patch.android_version = str(b.androidVersion, 40);
    if (b.appVersion) patch.app_version = str(b.appVersion, 40);
    if (b.deviceName) patch.device_name = str(b.deviceName, 120);
    await touchDevice(env, device.id, patch);
    const op = await operatorFor(env, device);
    const settings = await get(env, "SELECT setting_value FROM cx_settings WHERE setting_key = 'sms'");
    const smsCfg = parseJson(settings?.setting_value, {}) || {};
    const wsEnabled = smsCfg[workspace.id] ? smsCfg[workspace.id].enabled !== false : true;
    return json({
      ok: true,
      device: publicDevice({ ...device, ...patch, last_seen: nowIso() }),
      shop: publicWorkspace(workspace),
      administrator: publicOperator(op),
      smsEnabled: wsEnabled
    });
  }

  if (path === 'device/sim' && method === 'PATCH') {
    const b = await body();
    const patch = {};
    if (b.simSubscriptionId != null) patch.sim_subscription_id = String(b.simSubscriptionId);
    if (b.simCarrier != null) patch.sim_carrier = str(b.simCarrier, 80);
    if (b.phoneNumber != null) patch.phone_number = str(b.phoneNumber, 32);
    await touchDevice(env, device.id, patch);
    return json({ ok: true });
  }

  if (path === 'device/sim-carrier' && method === 'GET') {
    const params = url.searchParams;
    const numeric = str(params.get('mccMnc') || '').replace(/\D/g, '');
    const identifier = str(params.get('carrierName') || '').toLowerCase();
    if (numeric && !/^\d{5,6}$/.test(numeric)) return fail('Invalid MCC/MNC.', 400);
    if (!numeric && !identifier) return json({ supported: false });
    const rows = await all(env, 'SELECT * FROM cx_sim_carriers');
    const exact = numeric ? rows.find(r => r.mcc_mnc === numeric) : null;
    const byName = !exact && identifier
      ? rows.filter(r => !r.mcc_mnc && String(r.carrier_identifier || r.carrier_name || '').toLowerCase() === identifier)
      : [];
    const match = exact || (byName.length === 1 ? byName[0] : null);
    if (!match || !bool(match.active) || !match.balance_ussd_code) return json({ supported: false });
    return json({
      supported: true,
      carrier: {
        carrier_name: match.carrier_name,
        mcc_mnc: match.mcc_mnc,
        balance_ussd_code: match.balance_ussd_code,
        balance_pattern: match.balance_pattern
      }
    });
  }

  if (path === 'device/test' && method === 'POST') {
    const b = await body();
    await touchDevice(env, device.id, { status: b.ok === false ? 'pending_test' : 'active' });
    if (b.ok !== false && b.record !== false) {
      const phone = cleanPhone(b.phone || device.phone_number);
      if (phone) {
        await insert(env, 'cx_jobs', smsJobRow({
          workspaceId: workspace.id, clientId: null, apiKeyId: null,
          phone, name: 'Test', recipientType: 'manual',
          messageType: 'TEST', eventType: 'TEST',
          messageBody: str(b.message || `ConnectX test from gateway ${device.device_name || ''}.`, 1000),
          idempotencyKey: `TEST:${device.id}:${Date.now()}`
        }));
      }
    }
    return json({ ok: true, status: b.ok === false ? 'pending_test' : 'active' });
  }

  if (path === 'device/disconnect' && method === 'POST') {
    await update(env, 'cx_devices', { status: 'revoked', is_primary: 0, token_hash: null, updated_at: nowIso() }, 'id = ?', device.id);
    await logActivity(env, {
      actorType: 'device', actorId: device.id, actorLabel: device.device_name,
      action: 'device disconnected itself', entityType: 'device', entityId: device.id
    });
    return json({ ok: true });
  }

  /* ---------------- SMS job cancellation (queued only) ----------------- */
  const cancelJob = async jobId => {
    if (!jobId) return fail('jobId is required.', 400);
    const job = await get(env, "SELECT * FROM cx_jobs WHERE id = ? AND workspace_id = ? AND channel = 'sms'", jobId, workspace.id);
    if (!job) return fail('SMS job not found for this workspace.', 404);
    if (job.status !== 'queued') return fail('SMS is no longer queued. Refresh history before retrying.', 409);
    // Conditional guard: another gateway may claim the job between SELECT and UPDATE.
    const changes = await update(env, 'cx_jobs',
      { status: 'cancelled', error_message: 'Cancelled from gateway' },
      "id = ? AND workspace_id = ? AND status = 'queued'", jobId, workspace.id);
    if (!changes) return fail('SMS was already claimed by a gateway. Refresh history.', 409);
    ctx.waitUntil?.(dispatchWebhook(env, { ...job, status: 'cancelled' }, 'job.cancelled'));
    return json({ ok: true, cancelled: true });
  };
  if (path === 'device/jobs/cancel' && method === 'POST') {
    const b = await body();
    return cancelJob(str(b.jobId || b.id || ''));
  }
  if (path.startsWith('device/jobs/') && method === 'DELETE') {
    return cancelJob(decodeURIComponent(path.slice('device/jobs/'.length)));
  }

  /* ---------------- claim queued SMS jobs ------------------------------ */
  if (path === 'device/jobs/claim' && method === 'POST') {
    const b = await body();
    await touchDevice(env, device.id, { status: device.status === 'pending_test' ? 'pending_test' : 'active' });
    const limit = Math.min(20, Math.max(1, Number(b.limit || 8)));

    // Re-queue jobs stuck in "sending" for more than 10 minutes.
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await update(env, 'cx_jobs',
      { status: 'queued', claimed_at: null },
      "workspace_id = ? AND channel = 'sms' AND status = 'sending' AND (claimed_at IS NULL OR claimed_at < ?)",
      workspace.id, stale).catch(() => {});

    const queued = await all(env,
      `SELECT j.*, c.client_key, c.name AS client_name
         FROM cx_jobs j LEFT JOIN cx_clients c ON c.id = j.client_id
        WHERE j.workspace_id = ? AND j.channel = 'sms' AND j.status = 'queued'
        ORDER BY j.created_at ASC LIMIT ?`, workspace.id, limit);

    const claimed = [];
    for (const job of queued) {
      const attempts = Number(job.attempts || 0) + 1;
      const changes = await update(env, 'cx_jobs',
        { status: 'sending', device_id: device.id, claimed_at: nowIso(), attempts },
        "id = ? AND workspace_id = ? AND status = 'queued'", job.id, workspace.id).catch(() => 0);
      // Only dispatch jobs this device actually won the claim race for.
      if (changes > 0) {
        claimed.push({
          id: job.id,
          shop_id: workspace.id,               // legacy key kept for the phone app
          workspace_id: workspace.id,
          administrator_id: device.operator_id,
          phone_number: job.to_phone,
          message: job.message_body,
          event_type: job.event_type || job.message_type,
          message_type: job.message_type,
          recipient_name: job.recipient_name,
          invoice_id: job.reference_id,        // legacy key kept for the phone app
          reference_id: job.reference_id,
          reference_number: job.reference_number,
          client_key: job.client_key || null,
          client_name: job.client_name || null,
          created_at: job.created_at,
          attempts
        });
      }
    }
    return json({ jobs: claimed });
  }

  /* ---------------- report send result --------------------------------- */
  if (path === 'device/jobs/report' && method === 'POST') {
    const b = await body();
    const id = str(b.jobId || b.id || '');
    if (!id) return fail('jobId is required.', 400);
    const status = b.status === 'sent' ? 'sent' : 'failed';
    const job = await get(env, "SELECT * FROM cx_jobs WHERE id = ? AND workspace_id = ? AND channel = 'sms'", id, workspace.id);
    if (!job) return fail('SMS job not found for this workspace.', 404);
    if (job.device_id && job.device_id !== device.id && job.status === 'sent')
      return json({ ok: true, duplicate: true });
    const patch = {
      status,
      device_id: device.id,
      error_message: status === 'failed' ? str(b.error || 'SMS could not be sent', 400) : null
    };
    if (status === 'sent') patch.sent_at = nowIso();
    await update(env, 'cx_jobs', patch, "id = ? AND workspace_id = ?", id, workspace.id);
    await touchDevice(env, device.id, { status: 'active' });
    ctx.waitUntil?.(dispatchWebhook(env, { ...job, ...patch }, status === 'sent' ? 'job.sent' : 'job.failed'));
    return json({ ok: true, status });
  }

  /* ---------------- stats & activity ----------------------------------- */
  if (path === 'device/stats' && method === 'GET') {
    const today = dayStart(url.searchParams.get('utcOffsetMinutes'));
    if (!today) return fail('Invalid UTC offset.', 400);
    const [jobs, sentToday, last] = await Promise.all([
      all(env, "SELECT id, status, sent_at, created_at FROM cx_jobs WHERE workspace_id = ? AND channel = 'sms' AND created_at >= ?", workspace.id, today),
      all(env, "SELECT id FROM cx_jobs WHERE workspace_id = ? AND channel = 'sms' AND status = 'sent' AND sent_at >= ?", workspace.id, today),
      all(env, "SELECT created_at, sent_at, status FROM cx_jobs WHERE workspace_id = ? AND channel = 'sms' ORDER BY created_at DESC LIMIT 1", workspace.id)
    ]);
    await touchDevice(env, device.id);
    const op = await operatorFor(env, device);
    return json({
      sent: sentToday.length + jobs.filter(j => j.status === 'sent' && !j.sent_at).length,
      failed: jobs.filter(j => j.status === 'failed').length,
      pending: jobs.filter(j => j.status === 'queued' || j.status === 'sending').length,
      lastActivity: last[0]?.sent_at || last[0]?.created_at || null,
      device: publicDevice(device),
      shop: publicWorkspace(workspace),
      administrator: publicOperator(op)
    });
  }

  if (path === 'device/activity' && method === 'GET') {
    const range = url.searchParams.get('range') || 'today';
    const days = range === '30d' || range === '30' ? 30 : range === '7d' || range === '7' ? 7 : 1;
    const since = range === 'today' ? dayStart(url.searchParams.get('utcOffsetMinutes')) : new Date(Date.now() - days * 86400000).toISOString();
    if (!since) return fail('Invalid UTC offset.', 400);
    const rows = await all(env,
      `SELECT j.*, c.name AS client_name FROM cx_jobs j LEFT JOIN cx_clients c ON c.id = j.client_id
        WHERE j.workspace_id = ? AND j.channel = 'sms' AND j.created_at >= ?
        ORDER BY j.created_at DESC LIMIT 250`, workspace.id, since);
    return json({
      shop_id: workspace.id,
      items: rows.map(r => ({
        id: r.id,
        to_phone: r.to_phone,
        recipient_name: r.recipient_name,
        message_type: r.message_type,
        event_type: r.event_type,
        status: r.status,
        error_message: r.error_message,
        message_body: r.message_body,
        created_at: r.created_at,
        sent_at: r.sent_at,
        invoice_id: r.reference_id,          // legacy key kept for the phone app
        invoice_number: r.reference_number,
        client_name: r.client_name || null
      }))
    });
  }

  /* ---------------- email history (channel='email' jobs) --------------- */
  if (method === 'GET' && (path === 'device/emails' || path === 'device/emails/stats' || path.startsWith('device/emails/'))) {
    if (device.status !== 'active') return fail('Complete device setup before viewing email.', 403);
    const visible = "workspace_id = ? AND channel = 'email'";

    if (path === 'device/emails/stats') {
      const today = dayStart(url.searchParams.get('utcOffsetMinutes'));
      if (!today) return fail('Invalid UTC offset.', 400);
      const [todayRows, sentToday, latest] = await Promise.all([
        all(env, `SELECT status, sent_at FROM cx_jobs WHERE ${visible} AND created_at >= ?`, workspace.id, today),
        all(env, `SELECT id FROM cx_jobs WHERE ${visible} AND status = 'sent' AND sent_at >= ?`, workspace.id, today),
        all(env, `SELECT * FROM cx_jobs WHERE ${visible} ORDER BY created_at DESC, id DESC LIMIT 1`, workspace.id)
      ]);
      return json({
        sent: sentToday.length + todayRows.filter(r => r.status === 'sent' && !r.sent_at).length,
        failed: todayRows.filter(r => r.status === 'failed').length,
        pending: todayRows.filter(r => r.status === 'queued' || r.status === 'sending').length,
        latest: publicEmail(latest[0])
      });
    }

    if (path === 'device/emails') {
      const rawPage = url.searchParams.get('page') || '0';
      if (!/^(0|[1-9][0-9]{0,4})$/.test(rawPage) || Number(rawPage) > 10000) return fail('Invalid email history page.', 400);
      const page = Number(rawPage);
      const snapshot = url.searchParams.get('snapshot') || (page === 0 ? nowIso() : '');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(snapshot) || !Number.isFinite(Date.parse(snapshot)))
        return fail('Invalid email history snapshot.', 400);
      const rows = await all(env,
        `SELECT * FROM cx_jobs WHERE ${visible} AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        workspace.id, snapshot, EMAIL_PAGE_SIZE + 1, page * EMAIL_PAGE_SIZE);
      return json({
        items: rows.slice(0, EMAIL_PAGE_SIZE).map(r => publicEmail(r)),
        page,
        hasMore: rows.length > EMAIL_PAGE_SIZE,
        snapshot
      });
    }

    const id = path.slice('device/emails/'.length);
    if (!isUuid(id)) return fail('Invalid email ID.', 400);
    const message = await get(env, `SELECT * FROM cx_jobs WHERE ${visible} AND id = ?`, workspace.id, id);
    if (!message) return fail('Email not found for this workspace.', 404);
    return json(publicEmail(message, true));
  }

  return fail('Unknown ConnectX device endpoint.', 404);
}

/* ---------- job row factory (shared with the client API) ---------- */
export function smsJobRow({
  workspaceId, clientId = null, apiKeyId = null, phone, name = null, recipientId = null,
  recipientType = 'customer', messageType = null, eventType = null, referenceId = null,
  referenceNumber = null, messageBody, idempotencyKey = null, maxAttempts = 3
}) {
  return {
    id: uuid(),
    workspace_id: workspaceId,
    client_id: clientId,
    api_key_id: apiKeyId,
    channel: 'sms',
    to_phone: phone,
    recipient_type: recipientType || 'customer',
    recipient_id: recipientId || null,
    recipient_name: name ? str(name, 160) : null,
    message_type: messageType ? str(messageType, 80) : (eventType ? str(eventType, 80) : 'SMS'),
    event_type: eventType ? str(eventType, 80) : (messageType ? str(messageType, 80) : null),
    reference_id: referenceId || null,
    reference_number: referenceNumber ? str(referenceNumber, 80) : null,
    message_body: messageBody,
    status: 'queued',
    attempts: 0,
    max_attempts: maxAttempts,
    idempotency_key: idempotencyKey || null,
    created_at: nowIso()
  };
}

export { pairingCode, hashPassword, onlineOf };
