/* =====================================================================
   ConnectX Email Gateway — send email on behalf of connected apps.

   EMS, CareOS, InfluenceOS, PlugX (or any product) call
   POST /api/client/v1/email/send and ConnectX delivers the message
   through the provider configured on this website — so no app ever
   needs its own SMTP/Brevo setup.

   Providers are used through their HTTP send APIs. Cloudflare Workers
   cannot open raw SMTP sockets, but every major SMTP provider (Brevo
   included) offers an equivalent HTTP API; the key is created in the
   same dashboard as the SMTP credentials.

   The API key may live in either place (environment wins):
     1. Cloudflare secret / Pages env var  (BREVO_API_KEY, ...)
     2. ConnectX Control → Settings → Email sending (stored in D1)
   Keys are never returned by any GET endpoint.
   ===================================================================== */
import { get, parseJson } from './db.js';

export const EMAIL_PROVIDERS = {
  brevo:    { label: 'Brevo',     envKey: 'BREVO_API_KEY' },
  resend:   { label: 'Resend',    envKey: 'RESEND_API_KEY' },
  sendgrid: { label: 'SendGrid',  envKey: 'SENDGRID_API_KEY' },
  mailgun:  { label: 'Mailgun',   envKey: 'MAILGUN_API_KEY' },
  postmark: { label: 'Postmark',  envKey: 'POSTMARK_SERVER_TOKEN' }
};

const SEND_TIMEOUT_MS = 20000;

/** Load the merged email configuration (DB settings + environment secrets). */
export async function emailConfig(env) {
  const row = await get(env, "SELECT setting_value FROM cx_settings WHERE setting_key = 'email'");
  const cfg = parseJson(row?.setting_value, {}) || {};
  const provider = EMAIL_PROVIDERS[cfg.provider] ? cfg.provider : 'brevo';
  const envKey = EMAIL_PROVIDERS[provider].envKey;
  const envKeyValue = String(env[envKey] || '');
  const dbKeyValue = String(cfg.api_key || '');
  return {
    provider,
    apiKey: envKeyValue || dbKeyValue,
    keySource: envKeyValue ? 'environment' : (dbKeyValue ? 'database' : null),
    fromName: String(cfg.from_name || ''),
    fromEmail: String(cfg.from_email || ''),
    replyTo: String(cfg.reply_to || ''),
    enabled: cfg.enabled !== false,
    dailyLimit: Math.max(0, Number(cfg.daily_limit || 0)),
    mailgunDomain: String(env.MAILGUN_DOMAIN || cfg.mailgun_domain || '')
  };
}

/** Public provider list for the Settings UI (never includes key values). */
export function providerList(env) {
  return Object.entries(EMAIL_PROVIDERS).map(([id, p]) => ({
    id, label: p.label, envKey: p.envKey, envKeySet: !!env[p.envKey]
  }));
}

/** Wrap a plain-text body into a simple styled HTML document (EMS-compatible). */
export function plainTextHtml(text) {
  const esc = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<div style="font-family:Arial,sans-serif;color:#172033;line-height:1.55">${esc.replace(/\n/g, '<br>')}</div>`;
}

const addr = list => (list || []).map(email => ({ email }));

/**
 * Deliver one message through the configured provider.
 * msg: { to:[], cc:[], bcc:[], subject, html, text, fromName, fromEmail, replyTo }
 * Returns { ok:true, messageId } or { ok:false, error, unconfirmed? }.
 * `unconfirmed` means the provider call threw (often a timeout after the
 * provider may already have accepted the message) — never silently retry.
 */
export async function sendEmail(env, cfg, msg) {
  if (String(env.MOCK_EMAIL || '') === '1')
    return { ok: true, messageId: 'mock-msg-' + Date.now(), mocked: true };
  if (!cfg.apiKey) return { ok: false, error: 'No email provider API key is configured.' };

  const fromName = msg.fromName || cfg.fromName || 'ConnectX';
  const fromEmail = msg.fromEmail || cfg.fromEmail;
  const replyTo = msg.replyTo || cfg.replyTo;
  if (!fromEmail) return { ok: false, error: 'No From Email is configured.' };

  let res, out = {};
  try {
    switch (cfg.provider) {
      case 'brevo':
        res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': cfg.apiKey, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          body: JSON.stringify({
            sender: { name: fromName, email: fromEmail },
            ...(replyTo ? { replyTo: { email: replyTo } } : {}),
            to: addr(msg.to),
            ...(msg.cc?.length ? { cc: addr(msg.cc) } : {}),
            ...(msg.bcc?.length ? { bcc: addr(msg.bcc) } : {}),
            subject: msg.subject,
            ...(msg.html ? { htmlContent: msg.html } : {}),
            ...(msg.text ? { textContent: msg.text } : {})
          })
        });
        out = await res.json().catch(() => ({}));
        return res.ok
          ? { ok: true, messageId: out.messageId || null }
          : { ok: false, error: String(out.message || `Brevo rejected the message (HTTP ${res.status}).`).slice(0, 400) };

      case 'resend':
        res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          body: JSON.stringify({
            from: `${fromName} <${fromEmail}>`,
            ...(replyTo ? { reply_to: replyTo } : {}),
            to: msg.to, ...(msg.cc?.length ? { cc: msg.cc } : {}), ...(msg.bcc?.length ? { bcc: msg.bcc } : {}),
            subject: msg.subject,
            ...(msg.html ? { html: msg.html } : {}),
            ...(msg.text ? { text: msg.text } : {})
          })
        });
        out = await res.json().catch(() => ({}));
        return res.ok
          ? { ok: true, messageId: out.id || null }
          : { ok: false, error: String(out.message || `Resend rejected the message (HTTP ${res.status}).`).slice(0, 400) };

      case 'sendgrid': {
        const content = [];
        if (msg.text) content.push({ type: 'text/plain', value: msg.text });
        if (msg.html) content.push({ type: 'text/html', value: msg.html });
        res = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          body: JSON.stringify({
            personalizations: [{
              to: addr(msg.to),
              ...(msg.cc?.length ? { cc: addr(msg.cc) } : {}),
              ...(msg.bcc?.length ? { bcc: addr(msg.bcc) } : {})
            }],
            from: { email: fromEmail, name: fromName },
            ...(replyTo ? { reply_to: { email: replyTo } } : {}),
            subject: msg.subject,
            content: content.length ? content : [{ type: 'text/plain', value: '(empty)' }]
          })
        });
        if (res.ok) return { ok: true, messageId: res.headers.get('x-message-id') };
        out = await res.json().catch(() => ({}));
        const detail = Array.isArray(out.errors) ? out.errors.map(e => e.message).join('; ') : '';
        return { ok: false, error: String(detail || `SendGrid rejected the message (HTTP ${res.status}).`).slice(0, 400) };
      }

      case 'mailgun': {
        const domain = cfg.mailgunDomain;
        if (!domain) return { ok: false, error: 'Mailgun needs a sending domain (Settings → Email, or MAILGUN_DOMAIN).' };
        const form = new FormData();
        form.append('from', `${fromName} <${fromEmail}>`);
        for (const t of msg.to) form.append('to', t);
        for (const t of msg.cc || []) form.append('cc', t);
        for (const t of msg.bcc || []) form.append('bcc', t);
        form.append('subject', msg.subject);
        if (msg.text) form.append('text', msg.text);
        if (msg.html) form.append('html', msg.html);
        if (replyTo) form.append('h:Reply-To', replyTo);
        const basic = btoa(`api:${cfg.apiKey}`);
        res = await fetch(`https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, {
          method: 'POST', headers: { authorization: `Basic ${basic}` },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS), body: form
        });
        out = await res.json().catch(() => ({}));
        return res.ok
          ? { ok: true, messageId: out.id || null }
          : { ok: false, error: String(out.message || `Mailgun rejected the message (HTTP ${res.status}).`).slice(0, 400) };
      }

      case 'postmark':
        res = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: { 'x-postmark-server-token': cfg.apiKey, 'content-type': 'application/json', accept: 'application/json' },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          body: JSON.stringify({
            From: `${fromName} <${fromEmail}>`,
            To: msg.to.join(', '),
            ...(msg.cc?.length ? { Cc: msg.cc.join(', ') } : {}),
            ...(msg.bcc?.length ? { Bcc: msg.bcc.join(', ') } : {}),
            ...(replyTo ? { ReplyTo: replyTo } : {}),
            Subject: msg.subject,
            ...(msg.html ? { HtmlBody: msg.html } : {}),
            ...(msg.text ? { TextBody: msg.text } : {})
          })
        });
        out = await res.json().catch(() => ({}));
        return res.ok
          ? { ok: true, messageId: out.MessageID || null }
          : { ok: false, error: String(out.Message || `Postmark rejected the message (HTTP ${res.status}).`).slice(0, 400) };

      default:
        return { ok: false, error: `Unknown email provider "${cfg.provider}".` };
    }
  } catch {
    // A timeout may happen *after* the provider accepted the message. Never
    // leave the record "sending" forever or tell the app to blindly resend.
    return {
      ok: false, unconfirmed: true,
      error: 'Provider delivery unconfirmed. It may have been sent; check the recipient before retrying.'
    };
  }
}
