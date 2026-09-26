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
import { emailConfig, sendEmail, plainTextHtml } from './email.js';

const MAX_BULK = 100;

/** First defined, non-empty value among aliases (snake_case + EMS-style camelCase). */
function pick(b, ...names) {
  for (const n of names) if (b[n] !== undefined && b[n] !== null && b[n] !== '') return b[n];
  return undefined;
}

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
  const rawTo = pick(b, 'to_emails', 'toEmails', 'to');
  const to = Array.isArray(rawTo) ? rawTo : str(rawTo || '').split(',');
  const toList = to.map(x => str(x, 320).trim()).filter(x => x && isEmail(x));
  if (!toList.length) return { error: fail('At least one valid recipient email is required.', 400) };
  const status = ['queued', 'sending', 'sent', 'failed'].includes(b.status) ? b.status : 'sent';
  const rawCc = pick(b, 'cc_emails', 'ccEmails', 'cc');
  const rawBcc = pick(b, 'bcc_emails', 'bccEmails', 'bcc');
  return {
    row: {
      id: uuid(),
      workspace_id: workspaceId,
      client_id: clientId,
      api_key_id: apiKeyId,
      channel: 'email',
      from_email: str(pick(b, 'from_email', 'fromEmail') || '', 320),
      to_emails: addresses(toList),
      cc_emails: addresses(Array.isArray(rawCc) ? rawCc : str(rawCc || '').split(',')),
      bcc_emails: addresses(Array.isArray(rawBcc) ? rawBcc : str(rawBcc || '').split(',')),
      subject: str(b.subject || '(No subject)', 500),
      body_html: str(pick(b, 'body_html', 'bodyHtml', 'html') || '', 200000),
      custom_body: str(pick(b, 'custom_body', 'customBody', 'body', 'text') || '', 100000),
      recipient_type: str(pick(b, 'recipient_type', 'recipientType') || 'customer', 40),
      recipient_id: str(pick(b, 'recipient_id', 'recipientId') || '', 80) || null,
      recipient_name: str(pick(b, 'recipient_name', 'recipientName', 'name') || '', 160) || null,
      message_type: str(pick(b, 'message_type', 'messageType') || 'EMAIL', 80),
      event_type: str(pick(b, 'event_type', 'eventType') || '', 80) || null,
      reference_id: str(pick(b, 'reference_id', 'referenceId', 'invoice_id', 'invoiceId') || '', 80) || null,
      reference_number: str(pick(b, 'reference_number', 'referenceNumber', 'invoice_number', 'invoiceNumber') || '', 80) || null,
      status,
      attempts: status === 'sent' || status === 'failed' ? 1 : 0,
      idempotency_key: str(pick(b, 'idempotency_key', 'idempotencyKey') || '', 160) || null,
      error_message: str(pick(b, 'error_message', 'errorMessage') || '', 400) || null,
      provider_message_id: str(pick(b, 'provider_message_id', 'providerMessageId') || '', 160) || null,
      created_at: nowIso(),
      sent_at: status === 'sent' ? (pick(b, 'sent_at', 'sentAt') ? str(pick(b, 'sent_at', 'sentAt'), 40) : nowIso()) : null
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
  /* Accepts snake_case and EMS-style camelCase field names interchangeably:
     to/toPhone/phone, message/messageBody, recipientName, messageType,
     invoiceId/invoiceNumber, idempotencyKey, ...  (/sms/send is an alias
     of /sms so EMS-style call sites can keep their path.) */
  if ((path === 'client/v1/sms' || path === 'client/v1/sms/send') && method === 'POST') {
    const b = await body();
    const ws = await resolveWorkspace(env, key, pick(b, 'workspace', 'workspace_code', 'workspaceCode'));
    if (ws.error) return ws.error;
    const workspace = ws.workspace;
    if (workspace.status !== 'active') return fail('That workspace is paused in ConnectX Control.', 403);
    const settings = await settingsFor(env, workspace.id);
    if (!settings.enabled) return fail('SMS gateway is disabled for that workspace in ConnectX Control.', 403);

    const phone = cleanPhone(pick(b, 'to', 'toPhone', 'to_phone', 'phone'));
    if (!phone) return fail('A valid destination phone number is required.', 400);

    // Typed events (SALE, PAYMENT, ...) can be rendered from workspace templates
    // when the caller does not supply a message body.
    let messageBody = str(pick(b, 'message', 'message_body', 'messageBody') || '', 1600);
    const eventType = str(pick(b, 'event_type', 'eventType', 'messageType', 'message_type') || '', 80).toUpperCase() || null;
    if (!messageBody && eventType && settings.templates[eventType]) {
      messageBody = fillTemplate(settings.templates[eventType],
        templateVars(workspace.name, {
          name: pick(b, 'recipient_name', 'recipientName', 'name'),
          invoice: pick(b, 'reference_number', 'referenceNumber', 'invoice_number', 'invoiceNumber', 'reference_id', 'referenceId', 'invoice_id', 'invoiceId'),
          total: b.total, paid: b.paid, due: b.due, amount: b.amount, currency: b.currency
        }));
    }
    if (!messageBody) return fail('message is required (or send a known event_type to use a template).', 400);

    const idempotencyKey = str(pick(b, 'idempotency_key', 'idempotencyKey') || '', 160) || null;
    if (idempotencyKey) {
      const dup = await get(env,
        'SELECT id, status FROM cx_jobs WHERE workspace_id = ? AND client_id = ? AND idempotency_key = ?',
        workspace.id, key.client_id, idempotencyKey);
      if (dup) return json({ ok: true, duplicate: true, id: dup.id, job_id: dup.id, status: dup.status });
    }

    // EMS-compatible double-send guard: the same destination within 5 seconds
    // is almost always an accidental retry.
    const fiveSecAgo = new Date(Date.now() - 5000).toISOString();
    const recentDup = await get(env,
      "SELECT id FROM cx_jobs WHERE workspace_id = ? AND channel = 'sms' AND to_phone = ? AND created_at >= ? AND status != 'cancelled'",
      workspace.id, phone, fiveSecAgo);
    if (recentDup) return fail('Duplicate SMS detected. Please wait a few seconds before retrying.', 409);

    const limited = await enforceDailyLimit(env, key, workspace, 1);
    if (limited) return limited;

    const row = smsJobRow({
      workspaceId: workspace.id, clientId: key.client_id, apiKeyId: key.id,
      phone, name: pick(b, 'recipient_name', 'recipientName', 'name'),
      recipientId: pick(b, 'recipient_id', 'recipientId'),
      recipientType: pick(b, 'recipient_type', 'recipientType') || 'customer',
      messageType: pick(b, 'message_type', 'messageType') || eventType,
      eventType: pick(b, 'event_type', 'eventType') || eventType,
      referenceId: pick(b, 'reference_id', 'referenceId', 'invoice_id', 'invoiceId'),
      referenceNumber: pick(b, 'reference_number', 'referenceNumber', 'invoice_number', 'invoiceNumber'),
      messageBody, idempotencyKey
    });
    await insert(env, 'cx_jobs', row);
    return json({
      ok: true, id: row.id, job_id: row.id, status: 'queued', workspace: workspace.code,
      message: '✓ SMS queued for ConnectX'
    }, 201);
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
      const phone = cleanPhone(pick(m, 'to', 'toPhone', 'to_phone', 'phone'));
      const messageBody = str(pick(m, 'message', 'message_body', 'messageBody') || '', 1600);
      if (!phone || !messageBody) { results.push({ ok: false, error: 'phone and message are required', input: { to: m.to || m.toPhone } }); continue; }
      const row = smsJobRow({
        workspaceId: workspace.id, clientId: key.client_id, apiKeyId: key.id,
        phone, name: pick(m, 'recipient_name', 'recipientName', 'name'),
        recipientId: pick(m, 'recipient_id', 'recipientId'),
        recipientType: pick(m, 'recipient_type', 'recipientType') || 'customer',
        messageType: pick(m, 'message_type', 'messageType'), eventType: pick(m, 'event_type', 'eventType'),
        referenceId: pick(m, 'reference_id', 'referenceId', 'invoice_id', 'invoiceId'),
        referenceNumber: pick(m, 'reference_number', 'referenceNumber', 'invoice_number', 'invoiceNumber'),
        messageBody, idempotencyKey: str(pick(m, 'idempotency_key', 'idempotencyKey') || '', 160) || null
      });
      try {
        await insert(env, 'cx_jobs', row);
        results.push({ ok: true, id: row.id, job_id: row.id, status: 'queued', to: phone });
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

  /* ---------------- send email via ConnectX (real delivery) -------------
     The app does NOT need its own SMTP/Brevo setup: ConnectX delivers
     through the provider configured in Settings → Email and records the
     message so gateway phones and the console show it in email history. */
  if (path === 'client/v1/email/send' && method === 'POST') {
    const b = await body();
    const ws = await resolveWorkspace(env, key, pick(b, 'workspace', 'workspace_code', 'workspaceCode'));
    if (ws.error) return ws.error;
    const workspace = ws.workspace;
    if (workspace.status !== 'active') return fail('That workspace is paused in ConnectX Control.', 403);

    const cfg = await emailConfig(env);
    if (!cfg.enabled) return fail('Email sending is disabled in ConnectX Control → Settings → Email.', 403);
    if (!cfg.apiKey) return fail('No email provider is configured yet. Add an API key in ConnectX Control → Settings → Email.', 503);
    if (!cfg.fromEmail) return fail('Set a From Email in ConnectX Control → Settings → Email first.', 503);

    const list = v => (Array.isArray(v) ? v.map(x => str(x, 320)) : str(v || '', 2000).split(','))
      .map(x => x.trim()).filter(Boolean);
    const to = list(pick(b, 'to', 'to_emails', 'toEmails')).filter(isEmail);
    const cc = list(pick(b, 'cc', 'cc_emails', 'ccEmails')).filter(isEmail);
    const bcc = list(pick(b, 'bcc', 'bcc_emails', 'bccEmails')).filter(isEmail);
    if (!to.length) return fail('At least one valid recipient email is required (to).', 400);
    const subject = str(b.subject || '', 500).trim();
    if (!subject) return fail('subject is required.', 400);

    const htmlRaw = str(pick(b, 'html', 'body_html', 'bodyHtml') || '', 200000);
    const textRaw = str(pick(b, 'text', 'body', 'custom_body', 'customBody') || '', 100000);
    if (!htmlRaw && !textRaw) return fail('Send html and/or body (plain text).', 400);
    const html = htmlRaw || plainTextHtml(textRaw);

    const idempotencyKey = str(pick(b, 'idempotency_key', 'idempotencyKey') || '', 160) || null;
    if (idempotencyKey) {
      const dup = await get(env,
        "SELECT id, status FROM cx_jobs WHERE workspace_id = ? AND client_id = ? AND idempotency_key = ? AND channel = 'email'",
        workspace.id, key.client_id, idempotencyKey);
      if (dup) return json({ ok: true, duplicate: true, id: dup.id, job_id: dup.id, status: dup.status });
    }

    if (cfg.dailyLimit) {
      const today = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
      const used = await all(env,
        "SELECT id FROM cx_jobs WHERE channel = 'email' AND status IN ('sent','sending') AND created_at >= ?", today);
      if (used.length >= cfg.dailyLimit)
        return fail(`ConnectX daily email limit reached (${cfg.dailyLimit}/day). Raise it in Settings → Email.`, 429);
    }
    const limited = await enforceDailyLimit(env, key, workspace, 1);
    if (limited) return limited;

    const row = {
      id: uuid(), workspace_id: workspace.id, client_id: key.client_id, api_key_id: key.id,
      channel: 'email', from_email: cfg.fromEmail,
      to_emails: JSON.stringify(to), cc_emails: JSON.stringify(cc), bcc_emails: JSON.stringify(bcc),
      subject, body_html: html, custom_body: textRaw,
      recipient_type: str(pick(b, 'recipient_type', 'recipientType') || 'customer', 40),
      recipient_id: str(pick(b, 'recipient_id', 'recipientId') || '', 80) || null,
      recipient_name: str(pick(b, 'recipient_name', 'recipientName', 'name') || '', 160) || null,
      message_type: str(pick(b, 'message_type', 'messageType') || 'EMAIL', 80),
      event_type: str(pick(b, 'event_type', 'eventType') || '', 80) || null,
      reference_id: str(pick(b, 'reference_id', 'referenceId', 'invoice_id', 'invoiceId') || '', 80) || null,
      reference_number: str(pick(b, 'reference_number', 'referenceNumber', 'invoice_number', 'invoiceNumber') || '', 80) || null,
      status: 'sending', attempts: 1, idempotency_key: idempotencyKey,
      error_message: null, provider_message_id: null, created_at: nowIso(), sent_at: null
    };
    await insert(env, 'cx_jobs', row);

    const result = await sendEmail(env, cfg, {
      to, cc, bcc, subject, html, text: textRaw || undefined,
      fromName: str(pick(b, 'from_name', 'fromName') || '', 160) || cfg.fromName || key.client_name,
      replyTo: str(pick(b, 'reply_to', 'replyTo') || '', 320)
    });

    if (result.ok) {
      const sentAt = nowIso();
      await update(env, 'cx_jobs',
        { status: 'sent', provider_message_id: result.messageId || null, sent_at: sentAt }, 'id = ?', row.id);
      waitUntil?.(dispatchWebhookSafe(env, { ...row, status: 'sent', sent_at: sentAt }, 'job.sent'));
      return json({
        ok: true, id: row.id, job_id: row.id, status: 'sent',
        provider_message_id: result.messageId || null, workspace: workspace.code,
        message: '✓ Email sent via ConnectX'
      }, 201);
    }
    await update(env, 'cx_jobs', { status: 'failed', error_message: result.error }, 'id = ?', row.id);
    waitUntil?.(dispatchWebhookSafe(env, { ...row, status: 'failed', error_message: result.error }, 'job.failed'));
    return fail(result.error, 502);
  }

  /* ---------------- email history records ------------------------------ */
  if (path === 'client/v1/email' && method === 'POST') {
    const b = await body();
    const ws = await resolveWorkspace(env, key, pick(b, 'workspace', 'workspace_code', 'workspaceCode'));
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
