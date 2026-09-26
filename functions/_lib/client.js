/* =====================================================================
   ConnectX Client API (v1) — the integration surface for other products.

   EMS, CareOS, InfluenceOS, PlugX or any future system authenticates
   with an API key issued in ConnectX Control:

       X-ConnectX-Key: cxk_live_...        (or Authorization: Bearer cxk_...)

   Each key belongs to one SYSTEM. Messages target a SHOP of that system
   by the shop's own id/code inside that system ("shop" field) — ConnectX
   auto-registers unknown shops the first time they appear, and gateway
   phones paired to a shop claim its SMS jobs.

   Field names accept snake_case AND EMS-style camelCase (toPhone,
   messageBody, recipientName, idempotencyKey...). Results come back via
   polling or signed webhooks so the calling system can record statuses
   in its own database.
   ===================================================================== */
import { all, get, insert, update, parseJson } from './db.js';
import {
  json, fail, uuid, nowIso, str, cleanPhone, isEmail, isUuid, dayStart,
  sha256, onlineOf, DEFAULT_TEMPLATES, fillTemplate, templateVars
} from './core.js';
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
 * Resolve the target shop for a message. `requested` is the shop's own id
 * or code inside the calling system (e.g. an EMS store id). Unknown shops
 * are auto-registered so the first message "just works"; `nameHint`
 * (shop_name/storeName) gives the local record a readable label.
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
  if (shop.status !== 'active') return { error: fail('That shop is paused in ConnectX Control.', 403) };
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
    return fail(`Daily ConnectX limit reached for this API key (${limit}/day). Raise it in ConnectX Control.`, 429);
  return null;
}

async function smsSettings(env) {
  const row = await get(env, "SELECT setting_value FROM cx_settings WHERE setting_key = 'sms'");
  const cfg = parseJson(row?.setting_value, {}) || {};
  return {
    enabled: cfg.enabled !== false,
    templates: { ...DEFAULT_TEMPLATES, ...(cfg.templates || {}) }
  };
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

  /* ---------------- ping ---------------------------------------------- */
  if (path === 'client/v1/ping' && method === 'GET') {
    const devices = await all(env,
      "SELECT id, device_name, phone_number, sim_carrier, status, last_seen, shop_id FROM cx_devices WHERE status != 'revoked'");
    return json({
      ok: true,
      system: { key: key.system_key, name: key.system_name },
      gateways: devices.map(d => ({ ...d, online: onlineOf(d.last_seen) }))
    });
  }

  /* ---------------- send SMS (single) ---------------------------------- */
  /* Accepts snake_case and EMS-style camelCase field names interchangeably:
     to/toPhone/phone, message/messageBody, recipientName, messageType,
     invoiceId/invoiceNumber, idempotencyKey...  (/sms/send is an alias
     of /sms so EMS-style call sites can keep their path.) */
  if ((path === 'client/v1/sms' || path === 'client/v1/sms/send') && method === 'POST') {
    const b = await body();
    const ws = await resolveShop(env, systemId,
      pick(b, 'shop', 'shop_id', 'shopId', 'store_id', 'storeId', 'shop_code', 'shopCode'),
      str(pick(b, 'shop_name', 'shopName', 'storeName') || '', 160));
    if (ws.error) return ws.error;
    const shop = ws.shop;
    const settings = await smsSettings(env);
    if (!settings.enabled) return fail('SMS gateway is disabled in ConnectX Control.', 403);

    const phone = cleanPhone(pick(b, 'to', 'toPhone', 'to_phone', 'phone'));
    if (!phone) return fail('A valid destination phone number is required.', 400);

    // Typed events (SALE, PAYMENT, ...) can be rendered from templates
    // when the caller does not supply a message body.
    let messageBody = str(pick(b, 'message', 'message_body', 'messageBody') || '', 1600);
    const eventType = str(pick(b, 'event_type', 'eventType', 'messageType', 'message_type') || '', 80).toUpperCase() || null;
    if (!messageBody && eventType && settings.templates[eventType]) {
      messageBody = fillTemplate(settings.templates[eventType],
        templateVars(shop.name, {
          name: pick(b, 'recipient_name', 'recipientName', 'name'),
          invoice: pick(b, 'reference_number', 'referenceNumber', 'invoice_number', 'invoiceNumber', 'reference_id', 'referenceId', 'invoice_id', 'invoiceId'),
          total: b.total, paid: b.paid, due: b.due, amount: b.amount, currency: b.currency
        }));
    }
    if (!messageBody) return fail('message is required (or send a known event_type to use a template).', 400);

    const idempotencyKey = str(pick(b, 'idempotency_key', 'idempotencyKey') || '', 160) || null;
    if (idempotencyKey) {
      const dup = await get(env,
        'SELECT id, status FROM cx_jobs WHERE shop_id = ? AND system_id = ? AND idempotency_key = ?',
        shop.id, systemId, idempotencyKey);
      if (dup) return json({ ok: true, duplicate: true, id: dup.id, job_id: dup.id, status: dup.status });
    }

    // EMS-compatible double-send guard: the same destination within 5 seconds
    // is almost always an accidental retry.
    const fiveSecAgo = new Date(Date.now() - 5000).toISOString();
    const recentDup = await get(env,
      "SELECT id FROM cx_jobs WHERE shop_id = ? AND channel = 'sms' AND to_phone = ? AND created_at >= ? AND status != 'cancelled'",
      shop.id, phone, fiveSecAgo);
    if (recentDup) return fail('Duplicate SMS detected. Please wait a few seconds before retrying.', 409);

    const limited = await enforceDailyLimit(env, key, 1);
    if (limited) return limited;

    const row = smsJobRow({
      shopId: shop.id, systemId, apiKeyId: key.id,
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
      ok: true, id: row.id, job_id: row.id, status: 'queued',
      shop: shop.external_id, shop_name: shop.name,
      message: '✓ SMS queued for ConnectX'
    }, 201);
  }

  /* ---------------- send SMS (bulk) ------------------------------------ */
  if (path === 'client/v1/sms/bulk' && method === 'POST') {
    const b = await body();
    const messages = Array.isArray(b.messages) ? b.messages : [];
    if (!messages.length) return fail('messages[] is required.', 400);
    if (messages.length > MAX_BULK) return fail(`Bulk sends are limited to ${MAX_BULK} messages per request.`, 400);
    const ws = await resolveShop(env, systemId,
      pick(b, 'shop', 'shop_id', 'shopId', 'store_id', 'storeId', 'shop_code', 'shopCode'),
      str(pick(b, 'shop_name', 'shopName', 'storeName') || '', 160));
    if (ws.error) return ws.error;
    const shop = ws.shop;
    const settings = await smsSettings(env);
    if (!settings.enabled) return fail('SMS gateway is disabled in ConnectX Control.', 403);
    const limited = await enforceDailyLimit(env, key, messages.length);
    if (limited) return limited;

    const results = [];
    for (const m of messages) {
      const phone = cleanPhone(pick(m, 'to', 'toPhone', 'to_phone', 'phone'));
      const messageBody = str(pick(m, 'message', 'message_body', 'messageBody') || '', 1600);
      if (!phone || !messageBody) { results.push({ ok: false, error: 'phone and message are required', input: { to: m.to || m.toPhone } }); continue; }
      const row = smsJobRow({
        shopId: shop.id, systemId, apiKeyId: key.id,
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
    return json({ ok: true, shop: shop.external_id, accepted: results.filter(r => r.ok).length, results, message: '✓ Bulk SMS queued for ConnectX' }, 201);
  }

  /* ---------------- job status / list / cancel ------------------------- */
  if (path === 'client/v1/sms' && method === 'GET') {
    const status = str(url.searchParams.get('status') || '', 20);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
    const shopRef = str(url.searchParams.get('shop') || '', 80);
    const rows = await all(env,
      `SELECT j.*, sh.external_id AS shop_external_id, sh.name AS shop_name
         FROM cx_jobs j LEFT JOIN cx_shops sh ON sh.id = j.shop_id
        WHERE j.channel = 'sms' AND j.api_key_id = ?${shopRef ? ' AND j.shop_id IN (SELECT id FROM cx_shops WHERE system_id = ? AND (external_id = ? OR id = ? OR shop_code = ?))' : ''}${status && ['queued', 'sending', 'sent', 'failed', 'cancelled'].includes(status) ? ' AND j.status = ?' : ''}
        ORDER BY j.created_at DESC LIMIT ?`,
      key.id, ...(shopRef ? [systemId, shopRef, shopRef, shopRef] : []), ...(status ? [status] : []), limit);
    return json({ items: rows.map(r => ({ ...publicJob(r), shop: r.shop_external_id, shop_name: r.shop_name })), count: rows.length });
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
    return json({ ok: true, cancelled: true, id, job_id: id });
  }
  if (path.startsWith('client/v1/sms/') && method === 'GET') {
    const id = decodeURIComponent(path.slice('client/v1/sms/'.length));
    if (!isUuid(id)) return fail('Invalid job id.', 400);
    const job = await get(env,
      `SELECT j.*, sh.external_id AS shop_external_id, sh.name AS shop_name
         FROM cx_jobs j LEFT JOIN cx_shops sh ON sh.id = j.shop_id
        WHERE j.id = ? AND j.channel = 'sms' AND j.api_key_id = ?`, id, key.id);
    if (!job) return fail('Job not found for this API key.', 404);
    return json({ ...publicJob(job), shop: job.shop_external_id, shop_name: job.shop_name });
  }

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

  /* ---------------- shop stats & devices ------------------------------- */
  if (path === 'client/v1/stats' && method === 'GET') {
    const ws = await resolveShop(env, systemId,
      pick(Object.fromEntries(url.searchParams), 'shop', 'shop_id', 'storeId'), '', { create: false });
    if (ws.error) return ws.error;
    const today = dayStart(url.searchParams.get('utcOffsetMinutes')) || new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
    const rows = await all(env,
      'SELECT channel, status FROM cx_jobs WHERE shop_id = ? AND created_at >= ?', ws.shop.id, today);
    const count = (ch, st) => rows.filter(r => r.channel === ch && r.status === st).length;
    return json({
      shop: ws.shop.external_id,
      shop_name: ws.shop.name,
      today: {
        sms: { sent: count('sms', 'sent'), failed: count('sms', 'failed'), pending: count('sms', 'queued') + count('sms', 'sending') },
        email: { sent: count('email', 'sent'), failed: count('email', 'failed'), pending: count('email', 'queued') + count('email', 'sending') }
      }
    });
  }
  if (path === 'client/v1/devices' && method === 'GET') {
    const ws = await resolveShop(env, systemId,
      pick(Object.fromEntries(url.searchParams), 'shop', 'shop_id', 'storeId'), '', { create: false });
    if (ws.error) return ws.error;
    const devices = await all(env,
      "SELECT id, device_public_id, device_name, phone_number, sim_carrier, status, last_seen FROM cx_devices WHERE shop_id = ? AND status != 'revoked'",
      ws.shop.id);
    return json({ shop: ws.shop.external_id, devices: devices.map(d => ({ ...d, online: onlineOf(d.last_seen) })) });
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
