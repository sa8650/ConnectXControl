/* =====================================================================
   ConnectX Client API (v1) — the integration surface for other products.

   EMS, CareOS, InfluenceOS, PlugX or any future software authenticates
   with an API key issued in ConnectX Control:

       X-ConnectX-Key: cxk_live_...        (or Authorization: Bearer cxk_...)

   Keys may be scoped to one workspace or allowed for all workspaces, and
   carry a daily send limit. Clients push SMS jobs (delivered by paired
   Android gateways) and email history records (read by gateways), poll
   or receive webhook callbacks for results.

   This API is product-agnostic: nothing here knows what an "invoice" or
   a "shop" is in the caller's domain; reference_id/reference_number are
   opaque passthrough fields.
   ===================================================================== */
import { all, get, insert, update, parseJson } from './db.js';
import {
  json, fail, uuid, nowIso, str, bool, cleanPhone, isEmail, isUuid, dayStart,
  sha256, onlineOf, DEFAULT_TEMPLATES, fillTemplate, templateVars
} from './core.js';
import { logActivity } from './audit.js';
import { smsJobRow } from './device.js';

const MAX_BULK = 100;

async function authenticate(env, request) {
  const header = request.headers.get('x-connectx-key') || '';
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const key = (header.startsWith('cxk_') ? header : bearer).trim();
  if (!key.startsWith('cxk_')) return { error: fail('Missing ConnectX API key. Send X-ConnectX-Key: cxk_live_...', 401) };
  const keyHash = await sha256(key);
  const row = await get(env,
    `SELECT k.*, c.client_key, c.name AS client_name, c.status AS client_status, c.webhook_url
       FROM cx_api_keys k JOIN cx_clients c ON c.id = k.client_id
      WHERE k.key_hash = ?`, keyHash);
  if (!row) return { error: fail('Unknown ConnectX API key.', 401) };
  if (row.status !== 'active') return { error: fail('This API key was revoked. Create a new key in ConnectX Control.', 403) };
  if (row.client_status !== 'active') return { error: fail(`Client "${row.client_name}" is disabled in ConnectX Control.`, 403) };
  update(env, 'cx_api_keys', { last_used_at: nowIso() }, 'id = ?', row.id).catch(() => {});
  return { key: row };
}

async function resolveWorkspace(env, key, requested) {
  const code = str(requested || '').toUpperCase();
  if (key.workspace_id) {
    const ws = await get(env, 'SELECT * FROM cx_workspaces WHERE id = ?', key.workspace_id);
    if (!ws) return { error: fail('The workspace bound to this API key no longer exists.', 404) };
    if (code && ws.code !== code) return { error: fail('This API key is bound to a different workspace.', 403) };
    return { workspace: ws };
  }
  if (!code) return { error: fail('workspace is required (workspace code) for an all-workspace API key.', 400) };
  const ws = await get(env, 'SELECT * FROM cx_workspaces WHERE code = ? OR id = ?', code, code);
  if (!ws) return { error: fail(`Workspace "${code}" not found.`, 404) };
  return { workspace: ws };
}

async function enforceDailyLimit(env, key, workspace, count = 1) {
  const limit = Number(key.daily_limit || 0);
  if (!limit) return null;
  const today = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
  const rows = await all(env,
    "SELECT id FROM cx_jobs WHERE api_key_id = ? AND workspace_id = ? AND created_at >= ? AND status != 'cancelled'",
    key.id, workspace.id, today);
  if (rows.length + count > limit)
    return fail(`Daily ConnectX limit reached for this API key (${limit}/day). Raise it in ConnectX Control.`, 429);
  return null;
}

async function settingsFor(env, workspaceId) {
  const row = await get(env, "SELECT setting_value FROM cx_settings WHERE setting_key = 'sms'");
  const all = parseJson(row?.setting_value, {}) || {};
  const ws = all[workspaceId] || {};
  return {
    enabled: ws.enabled !== false,
    templates: { ...DEFAULT_TEMPLATES, ...(ws.templates || {}) }
  };
}

function emailJobRow({ workspaceId, clientId, apiKeyId, b }) {
  const addresses = v => JSON.stringify(Array.isArray(v) ? v.map(x => str(x, 320)).filter(Boolean) : []);
  const to = Array.isArray(b.to_emails || b.to) ? (b.to_emails || b.to) : str(b.to_emails || b.to || '').split(',');
  const toList = to.map(x => str(x, 320)).filter(x => x && isEmail(x));
  if (!toList.length) return { error: fail('At least one valid recipient email is required.', 400) };
  const status = ['queued', 'sending', 'sent', 'failed'].includes(b.status) ? b.status : 'sent';
  return {
    row: {
      id: uuid(),
      workspace_id: workspaceId,
      client_id: clientId,
      api_key_id: apiKeyId,
      channel: 'email',
      from_email: str(b.from_email || '', 320),
      to_emails: addresses(toList),
      cc_emails: addresses(Array.isArray(b.cc_emails) ? b.cc_emails : str(b.cc_emails || '').split(',')),
      bcc_emails: addresses(Array.isArray(b.bcc_emails) ? b.bcc_emails : []),
      subject: str(b.subject || '(No subject)', 500),
      body_html: str(b.body_html || b.html || '', 200000),
      custom_body: str(b.custom_body || b.body || '', 100000),
      recipient_type: str(b.recipient_type || 'customer', 40),
      recipient_id: str(b.recipient_id || '', 80) || null,
      recipient_name: str(b.recipient_name || '', 160) || null,
      message_type: str(b.message_type || 'EMAIL', 80),
      event_type: str(b.event_type || '', 80) || null,
      reference_id: str(b.reference_id || '', 80) || null,
      reference_number: str(b.reference_number || '', 80) || null,
      status,
      attempts: status === 'sent' || status === 'failed' ? 1 : 0,
      idempotency_key: str(b.idempotency_key || '', 160) || null,
      error_message: str(b.error_message || '', 400) || null,
      provider_message_id: str(b.provider_message_id || '', 160) || null,
      created_at: nowIso(),
      sent_at: status === 'sent' ? (b.sent_at ? str(b.sent_at, 40) : nowIso()) : null
    }
  };
}

/* ===================================================================== */
export async function clientRoutes(ctx) {
  const { env, request, path, method, url, waitUntil } = ctx;
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  const auth = await authenticate(env, request);
  if (auth.error) return auth.error;
  const key = auth.key;

  /* ---------------- ping ---------------------------------------------- */
  if (path === 'client/v1/ping' && method === 'GET') {
    let workspace = null;
    if (key.workspace_id) workspace = await get(env, 'SELECT * FROM cx_workspaces WHERE id = ?', key.workspace_id);
    const devices = await all(env,
      "SELECT id, device_name, phone_number, sim_carrier, status, last_seen FROM cx_devices WHERE status != 'revoked'" +
      (workspace ? ' AND workspace_id = ?' : ''), ...(workspace ? [workspace.id] : []));
    return json({
      ok: true,
      client: { key: key.client_key, name: key.client_name },
      scope: workspace ? { workspace_id: workspace.id, code: workspace.code, name: workspace.name } : 'all',
      gateways: devices.map(d => ({ ...d, online: onlineOf(d.last_seen) }))
    });
  }

  /* ---------------- send SMS (single) ---------------------------------- */
  if (path === 'client/v1/sms' && method === 'POST') {
    const b = await body();
    const ws = await resolveWorkspace(env, key, b.workspace || b.workspace_code);
    if (ws.error) return ws.error;
    const workspace = ws.workspace;
    if (workspace.status !== 'active') return fail('That workspace is paused in ConnectX Control.', 403);
    const settings = await settingsFor(env, workspace.id);
    if (!settings.enabled) return fail('SMS gateway is disabled for that workspace in ConnectX Control.', 403);

    const phone = cleanPhone(b.to || b.phone || b.to_phone);
    if (!phone) return fail('A valid destination phone number is required.', 400);

    // Typed events (SALE, PAYMENT, ...) can be rendered from workspace templates
    // when the caller does not supply a message body.
    let messageBody = str(b.message || b.message_body || '', 1600);
    const eventType = str(b.event_type || b.messageType || b.message_type || '', 80).toUpperCase() || null;
    if (!messageBody && eventType && settings.templates[eventType]) {
      messageBody = fillTemplate(settings.templates[eventType],
        templateVars(workspace.name, {
          name: b.recipient_name || b.name, invoice: b.reference_number || b.reference_id,
          total: b.total, paid: b.paid, due: b.due, amount: b.amount, currency: b.currency
        }));
    }
    if (!messageBody) return fail('message is required (or send a known event_type to use a template).', 400);

    const idempotencyKey = str(b.idempotency_key || '', 160) || null;
    if (idempotencyKey) {
      const dup = await get(env,
        'SELECT id, status FROM cx_jobs WHERE workspace_id = ? AND client_id = ? AND idempotency_key = ?',
        workspace.id, key.client_id, idempotencyKey);
      if (dup) return json({ ok: true, duplicate: true, job_id: dup.id, status: dup.status });
    }

    const limited = await enforceDailyLimit(env, key, workspace, 1);
    if (limited) return limited;

    const row = smsJobRow({
      workspaceId: workspace.id, clientId: key.client_id, apiKeyId: key.id,
      phone, name: b.recipient_name || b.name, recipientId: b.recipient_id,
      recipientType: b.recipient_type || 'customer',
      messageType: b.message_type || eventType, eventType: b.event_type || eventType,
      referenceId: b.reference_id || b.invoice_id, referenceNumber: b.reference_number || b.invoice_number,
      messageBody, idempotencyKey
    });
    await insert(env, 'cx_jobs', row);
    return json({ ok: true, job_id: row.id, status: 'queued', workspace: workspace.code }, 201);
  }

  /* ---------------- send SMS (bulk) ------------------------------------ */
  if (path === 'client/v1/sms/bulk' && method === 'POST') {
    const b = await body();
    const messages = Array.isArray(b.messages) ? b.messages : [];
    if (!messages.length) return fail('messages[] is required.', 400);
    if (messages.length > MAX_BULK) return fail(`Bulk sends are limited to ${MAX_BULK} messages per request.`, 400);
    const ws = await resolveWorkspace(env, key, b.workspace || b.workspace_code);
    if (ws.error) return ws.error;
    const workspace = ws.workspace;
    if (workspace.status !== 'active') return fail('That workspace is paused in ConnectX Control.', 403);
    const settings = await settingsFor(env, workspace.id);
    if (!settings.enabled) return fail('SMS gateway is disabled for that workspace in ConnectX Control.', 403);
    const limited = await enforceDailyLimit(env, key, workspace, messages.length);
    if (limited) return limited;

    const results = [];
    for (const m of messages) {
      const phone = cleanPhone(m.to || m.phone);
      const messageBody = str(m.message || m.message_body || '', 1600);
      if (!phone || !messageBody) { results.push({ ok: false, error: 'phone and message are required', input: { to: m.to } }); continue; }
      const row = smsJobRow({
        workspaceId: workspace.id, clientId: key.client_id, apiKeyId: key.id,
        phone, name: m.recipient_name || m.name, recipientId: m.recipient_id,
        recipientType: m.recipient_type || 'customer',
        messageType: m.message_type, eventType: m.event_type,
        referenceId: m.reference_id, referenceNumber: m.reference_number,
        messageBody, idempotencyKey: str(m.idempotency_key || '', 160) || null
      });
      try {
        await insert(env, 'cx_jobs', row);
        results.push({ ok: true, job_id: row.id, status: 'queued', to: phone });
      } catch (e) {
        if (/unique|idempotency/i.test(String(e.message || ''))) results.push({ ok: true, duplicate: true, to: phone });
        else results.push({ ok: false, error: 'queue failed', to: phone });
      }
    }
    return json({ ok: true, workspace: workspace.code, accepted: results.filter(r => r.ok).length, results }, 201);
  }

  /* ---------------- job status / list / cancel ------------------------- */
  if (path.startsWith('client/v1/sms/') && method === 'GET') {
    const id = decodeURIComponent(path.slice('client/v1/sms/'.length));
    if (!isUuid(id)) return fail('Invalid job id.', 400);
    const job = await get(env, "SELECT * FROM cx_jobs WHERE id = ? AND channel = 'sms' AND api_key_id = ?", id, key.id);
    if (!job) return fail('Job not found for this API key.', 404);
    return json(publicJob(job));
  }
  if (path === 'client/v1/sms' && method === 'GET') {
    const status = str(url.searchParams.get('status') || '', 20);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
    const wsFilter = key.workspace_id ? ' AND workspace_id = ?' : '';
    const wsBind = key.workspace_id ? [key.workspace_id] : [];
    const rows = await all(env,
      `SELECT * FROM cx_jobs WHERE channel = 'sms' AND api_key_id = ?${wsFilter}${status && ['queued', 'sending', 'sent', 'failed', 'cancelled'].includes(status) ? ' AND status = ?' : ''} ORDER BY created_at DESC LIMIT ?`,
      key.id, ...wsBind, ...(status ? [status] : []), limit);
    return json({ items: rows.map(publicJob), count: rows.length });
  }
  if (path.startsWith('client/v1/sms/') && path.endsWith('/cancel') && method === 'POST') {
    const id = decodeURIComponent(path.slice('client/v1/sms/'.length, -'/cancel'.length));
    const job = await get(env, "SELECT * FROM cx_jobs WHERE id = ? AND channel = 'sms' AND api_key_id = ?", id, key.id);
    if (!job) return fail('Job not found for this API key.', 404);
    if (job.status !== 'queued') return fail('Only queued jobs can be cancelled.', 409);
    const changes = await update(env, 'cx_jobs',
      { status: 'cancelled', error_message: 'Cancelled by client API' },
      "id = ? AND status = 'queued'", id);
    if (!changes) return fail('Job was already claimed by a gateway.', 409);
    waitUntil?.(dispatchWebhookSafe(env, { ...job, status: 'cancelled' }, 'job.cancelled'));
    return json({ ok: true, cancelled: true, job_id: id });
  }

  /* ---------------- email history records ------------------------------ */
  if (path === 'client/v1/email' && method === 'POST') {
    const b = await body();
    const ws = await resolveWorkspace(env, key, b.workspace || b.workspace_code);
    if (ws.error) return ws.error;
    const built = emailJobRow({ workspaceId: ws.workspace.id, clientId: key.client_id, apiKeyId: key.id, b });
    if (built.error) return built.error;
    if (built.row.idempotency_key) {
      const dup = await get(env,
        "SELECT id, status FROM cx_jobs WHERE workspace_id = ? AND client_id = ? AND idempotency_key = ? AND channel = 'email'",
        ws.workspace.id, key.client_id, built.row.idempotency_key);
      if (dup) return json({ ok: true, duplicate: true, job_id: dup.id, status: dup.status });
    }
    await insert(env, 'cx_jobs', built.row);
    return json({ ok: true, job_id: built.row.id, status: built.row.status }, 201);
  }
  if (path === 'client/v1/email' && method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 30)));
    const wsFilter = key.workspace_id ? ' AND workspace_id = ?' : '';
    const rows = await all(env,
      `SELECT * FROM cx_jobs WHERE channel = 'email' AND api_key_id = ?${wsFilter} ORDER BY created_at DESC LIMIT ?`,
      key.id, ...(key.workspace_id ? [key.workspace_id] : []), limit);
    return json({ items: rows.map(r => ({ ...publicJob(r), subject: r.subject, to_emails: parseJson(r.to_emails, []) })), count: rows.length });
  }
  if (path.match(/^client\/v1\/email\/[^/]+$/) && method === 'PATCH') {
    const id = decodeURIComponent(path.slice('client/v1/email/'.length));
    const b = await body();
    const job = await get(env, "SELECT * FROM cx_jobs WHERE id = ? AND channel = 'email' AND api_key_id = ?", id, key.id);
    if (!job) return fail('Email record not found for this API key.', 404);
    const patch = {};
    if (['queued', 'sending', 'sent', 'failed'].includes(b.status)) patch.status = b.status;
    if (b.error_message !== undefined) patch.error_message = str(b.error_message, 400) || null;
    if (b.provider_message_id !== undefined) patch.provider_message_id = str(b.provider_message_id, 160) || null;
    if (patch.status === 'sent' && !job.sent_at) patch.sent_at = nowIso();
    if (!Object.keys(patch).length) return fail('Nothing to update. Send status and/or error_message.', 400);
    await update(env, 'cx_jobs', patch, 'id = ?', id);
    return json({ ok: true, job: publicJob({ ...job, ...patch }) });
  }

  /* ---------------- workspace stats & devices -------------------------- */
  if (path === 'client/v1/stats' && method === 'GET') {
    const ws = await resolveWorkspace(env, key, url.searchParams.get('workspace'));
    if (ws.error) return ws.error;
    const today = dayStart(url.searchParams.get('utcOffsetMinutes')) || new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
    const rows = await all(env,
      'SELECT channel, status FROM cx_jobs WHERE workspace_id = ? AND created_at >= ?', ws.workspace.id, today);
    const count = (ch, st) => rows.filter(r => r.channel === ch && r.status === st).length;
    return json({
      workspace: ws.workspace.code,
      today: {
        sms: { sent: count('sms', 'sent'), failed: count('sms', 'failed'), pending: count('sms', 'queued') + count('sms', 'sending') },
        email: { sent: count('email', 'sent'), failed: count('email', 'failed'), pending: count('email', 'queued') + count('email', 'sending') }
      }
    });
  }
  if (path === 'client/v1/devices' && method === 'GET') {
    const ws = await resolveWorkspace(env, key, url.searchParams.get('workspace'));
    if (ws.error) return ws.error;
    const devices = await all(env,
      "SELECT id, device_public_id, device_name, phone_number, sim_carrier, status, last_seen FROM cx_devices WHERE workspace_id = ? AND status != 'revoked'",
      ws.workspace.id);
    return json({ workspace: ws.workspace.code, devices: devices.map(d => ({ ...d, online: onlineOf(d.last_seen) })) });
  }

  return fail('Unknown ConnectX client endpoint.', 404);
}

function publicJob(j) {
  return {
    id: j.id,
    channel: j.channel,
    workspace_id: j.workspace_id,
    status: j.status,
    to_phone: j.to_phone || null,
    recipient_name: j.recipient_name || null,
    message_type: j.message_type || null,
    event_type: j.event_type || null,
    reference_id: j.reference_id || null,
    reference_number: j.reference_number || null,
    attempts: Number(j.attempts || 0),
    error_message: j.error_message || null,
    created_at: j.created_at,
    sent_at: j.sent_at || null
  };
}

function dispatchWebhookSafe(env, job, event) {
  return import('./webhook.js').then(m => m.dispatchWebhook(env, job, event)).catch(() => {});
}
