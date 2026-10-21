/* =====================================================================
   ConnectX Client API compatibility for existing email integrations only.
   The router exposes authenticated client/v1/email* routes. SMS sending,
   queueing, polling, and dispatch do not exist on this Control API; EMS owns
   the durable SMS queue and Android reports directly to EMS.

   Existing system API keys continue to authenticate email send/history
   records. The configured Control provider sends email and records the result.
   ===================================================================== */
import { all, get, insert, update, parseJson } from './db.js';
import { json, fail, uuid, nowIso, str, isEmail, isUuid, sha256 } from './core.js';
import { emailConfig, sendEmail, plainTextHtml } from './email.js';

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
    `SELECT k.*, s.system_key, s.name AS system_name, s.status AS system_status, s.webhook_url
       FROM cx_api_keys k JOIN cx_systems s ON s.id = k.system_id
      WHERE k.key_hash = ?`, keyHash);
  if (!row) return { error: fail('Unknown ConnectX API key.', 401) };
  if (row.status !== 'active') return { error: fail('This API key was revoked. Create a new key in ConnectX Control.', 403) };
  if (row.system_status !== 'active') return { error: fail(`System "${row.system_name}" is disabled in ConnectX Control.`, 403) };
  update(env, 'cx_api_keys', { last_used_at: nowIso() }, 'id = ?', row.id).catch(() => {});
  return { key: row };
}

/**
 * Resolve the target shop for an existing email integration. `requested` is
 * the shop's own id or code inside the calling system. Unknown shops are
 * registered for compatibility; `nameHint` supplies a readable local label.
 */
async function resolveShop(env, systemId, requested, nameHint = '', { create = true } = {}) {
  const ref = str(requested || '', 80);
  if (!ref) return { error: fail('shop is required (the shop id or code inside your system).', 400) };
  let shop = await get(env,
    'SELECT * FROM cx_shops WHERE system_id = ? AND (external_id = ? OR id = ? OR shop_code = ?)',
    systemId, ref, ref, ref);
  if (!shop && create) {
    shop = {
      id: uuid(), system_id: systemId, external_id: ref,
      name: str(nameHint || ref, 160), shop_code: '', address: '', phone: '', category: '',
      system_status: 'active', status: 'active', created_at: nowIso(), updated_at: nowIso()
    };
    try {
      await insert(env, 'cx_shops', shop);
    } catch {
      shop = await get(env, 'SELECT * FROM cx_shops WHERE system_id = ? AND external_id = ?', systemId, ref);
      if (!shop) return { error: fail('Shop could not be registered.', 500) };
    }
  }
  if (!shop) return { error: fail(`Shop "${ref}" not found for this system.`, 404) };
  if (shop.status !== 'active') return { error: fail('That shop is inactive in the existing ConnectX integration.', 403) };
  if (shop.system_status === 'inactive') return { error: fail('That shop is deactivated in your system.', 403) };
  return { shop };
}

async function enforceDailyLimit(env, key, count = 1) {
  const limit = Number(key.daily_limit || 0);
  if (!limit) return null;
  const today = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
  const rows = await all(env,
    "SELECT id FROM cx_jobs WHERE api_key_id = ? AND created_at >= ? AND status != 'cancelled'",
    key.id, today);
  if (rows.length + count > limit)
    return fail(`Daily email limit reached for this existing API key (${limit}/day). Contact the platform owner to review the configured limit.`, 429);
  return null;
}

function emailJobRow({ shopId, systemId, apiKeyId, b }) {
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
      shop_id: shopId,
      system_id: systemId,
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
  const systemId = key.system_id;

  /* ---------------- send email via ConnectX (real delivery) -------------
     The app does NOT need its own SMTP/Brevo setup: ConnectX delivers
     through the provider configured in Settings → Email and records the
     message so gateway phones and the console show it in email history. */
  if (path === 'client/v1/email/send' && method === 'POST') {
    const b = await body();
    const ws = await resolveShop(env, systemId,
      pick(b, 'shop', 'shop_id', 'shopId', 'store_id', 'storeId', 'shop_code', 'shopCode'),
      str(pick(b, 'shop_name', 'shopName', 'storeName') || '', 160));
    if (ws.error) return ws.error;
    const shop = ws.shop;

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
        "SELECT id, status FROM cx_jobs WHERE shop_id = ? AND system_id = ? AND idempotency_key = ? AND channel = 'email'",
        shop.id, systemId, idempotencyKey);
      if (dup) return json({ ok: true, duplicate: true, id: dup.id, job_id: dup.id, status: dup.status });
    }

    if (cfg.dailyLimit) {
      const today = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
      const used = await all(env,
        "SELECT id FROM cx_jobs WHERE channel = 'email' AND status IN ('sent','sending') AND created_at >= ?", today);
      if (used.length >= cfg.dailyLimit)
        return fail(`ConnectX daily email limit reached (${cfg.dailyLimit}/day). Raise it in Settings → Email.`, 429);
    }
    const limited = await enforceDailyLimit(env, key, 1);
    if (limited) return limited;

    const row = {
      id: uuid(), shop_id: shop.id, system_id: systemId, api_key_id: key.id,
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
      fromName: str(pick(b, 'from_name', 'fromName') || '', 160) || cfg.fromName || key.system_name,
      replyTo: str(pick(b, 'reply_to', 'replyTo') || '', 320)
    });

    if (result.ok) {
      const sentAt = nowIso();
      await update(env, 'cx_jobs',
        { status: 'sent', provider_message_id: result.messageId || null, sent_at: sentAt }, 'id = ?', row.id);
      waitUntil?.(dispatchWebhookSafe(env, { ...row, status: 'sent', sent_at: sentAt }, 'job.sent'));
      return json({
        ok: true, id: row.id, job_id: row.id, status: 'sent',
        provider_message_id: result.messageId || null,
        shop: shop.external_id, message: '✓ Email sent via ConnectX'
      }, 201);
    }
    await update(env, 'cx_jobs', { status: 'failed', error_message: result.error }, 'id = ?', row.id);
    waitUntil?.(dispatchWebhookSafe(env, { ...row, status: 'failed', error_message: result.error }, 'job.failed'));
    return fail(result.error, 502);
  }

  /* ---------------- email history records ------------------------------ */
  if (path === 'client/v1/email' && method === 'POST') {
    const b = await body();
    const ws = await resolveShop(env, systemId,
      pick(b, 'shop', 'shop_id', 'shopId', 'store_id', 'storeId', 'shop_code', 'shopCode'),
      str(pick(b, 'shop_name', 'shopName', 'storeName') || '', 160));
    if (ws.error) return ws.error;
    const built = emailJobRow({ shopId: ws.shop.id, systemId, apiKeyId: key.id, b });
    if (built.error) return built.error;
    if (built.row.idempotency_key) {
      const dup = await get(env,
        "SELECT id, status FROM cx_jobs WHERE shop_id = ? AND system_id = ? AND idempotency_key = ? AND channel = 'email'",
        ws.shop.id, systemId, built.row.idempotency_key);
      if (dup) return json({ ok: true, duplicate: true, id: dup.id, job_id: dup.id, status: dup.status });
    }
    await insert(env, 'cx_jobs', built.row);
    return json({ ok: true, id: built.row.id, job_id: built.row.id, status: built.row.status, shop: ws.shop.external_id }, 201);
  }
  if (path === 'client/v1/email' && method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 30)));
    const rows = await all(env,
      `SELECT j.*, sh.external_id AS shop_external_id FROM cx_jobs j LEFT JOIN cx_shops sh ON sh.id = j.shop_id
        WHERE j.channel = 'email' AND j.api_key_id = ? ORDER BY j.created_at DESC LIMIT ?`,
      key.id, limit);
    return json({
      items: rows.map(r => ({
        ...publicJob(r), shop: r.shop_external_id, subject: r.subject, to_emails: parseJson(r.to_emails, [])
      })),
      count: rows.length
    });
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

  return fail('Unknown ConnectX client endpoint.', 404);
}

function publicJob(j) {
  return {
    id: j.id,
    channel: j.channel,
    shop_id: j.shop_id,
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
