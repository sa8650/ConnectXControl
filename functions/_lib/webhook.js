/* =====================================================================
   ConnectX outbound webhooks — notify an integrated system (EMS, CareOS,
   InfluenceOS, PlugX...) when its jobs change state, so it can record the
   result in its own database. Best-effort: failures are logged, never
   surfaced to the gateway device.
   Payloads are signed with HMAC-SHA256 when WEBHOOK_SIGNING_SECRET set.
   ===================================================================== */
import { get } from './db.js';
import { hmac, hex } from './core.js';

export async function dispatchWebhook(env, job, event) {
  try {
    if (!job?.system_id) return;
    const system = await get(env, 'SELECT webhook_url, name, system_key FROM cx_systems WHERE id = ?', job.system_id);
    const target = system?.webhook_url;
    if (!target) return;
    let targetUrl;
    try {
      targetUrl = new URL(target);
      if (targetUrl.protocol !== 'https:') return;               // https only
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(targetUrl.hostname)) return;
    } catch { return; }

    const shop = await get(env, 'SELECT external_id, name FROM cx_shops WHERE id = ?', job.shop_id);
    const payload = {
      event,                                   // job.sent | job.failed | job.cancelled
      system_key: system.system_key,
      job: {
        id: job.id,
        channel: job.channel || 'sms',
        status: job.status,
        shop_id: job.shop_id,
        shop_external_id: shop?.external_id || null,   // the shop id inside YOUR system
        shop_name: shop?.name || null,
        to_phone: job.to_phone || null,
        to_emails: job.to_emails || null,
        recipient_name: job.recipient_name || null,
        message_type: job.message_type || null,
        event_type: job.event_type || null,
        reference_id: job.reference_id || null,
        reference_number: job.reference_number || null,
        error_message: job.error_message || null,
        sent_at: job.sent_at || null
      },
      sent_at: new Date().toISOString()
    };
    const headers = { 'content-type': 'application/json', 'user-agent': 'ConnectX-Webhook/1.0' };
    if (env.WEBHOOK_SIGNING_SECRET) {
      const body = JSON.stringify(payload);
      headers['x-connectx-event'] = event;
      headers['x-connectx-signature'] = 'sha256=' + hex(await hmac(body, env.WEBHOOK_SIGNING_SECRET));
      await fetch(targetUrl.href, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(8000)
      }).catch(e => console.error('webhook delivery failed', system.system_key, e));
    } else {
      await fetch(targetUrl.href, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
      }).catch(e => console.error('webhook delivery failed', system.system_key, e));
    }
  } catch (e) {
    console.error('dispatchWebhook', e);
  }
}
