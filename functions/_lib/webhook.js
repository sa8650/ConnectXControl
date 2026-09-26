/* =====================================================================
   ConnectX outbound webhooks — notify a client product (EMS, CareOS,
   InfluenceOS, PlugX...) when its jobs change state. Best-effort:
   failures are logged, never surfaced to the gateway device.
   Payloads are signed with HMAC-SHA256 when WEBHOOK_SIGNING_SECRET set.
   ===================================================================== */
import { get } from './db.js';
import { hmac, hex } from './core.js';

export async function dispatchWebhook(env, job, event) {
  try {
    if (!job?.client_id) return;
    const client = await get(env, 'SELECT webhook_url, name, client_key FROM cx_clients WHERE id = ?', job.client_id);
    const target = client?.webhook_url;
    if (!target) return;
    let targetUrl;
    try {
      targetUrl = new URL(target);
      if (targetUrl.protocol !== 'https:') return;               // https only
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(targetUrl.hostname)) return;
    } catch { return; }

    const payload = {
      event,                                   // job.sent | job.failed | job.cancelled
      client_key: client.client_key,
      job: {
        id: job.id,
        channel: job.channel || 'sms',
        workspace_id: job.workspace_id,
        status: job.status,
        to_phone: job.to_phone || null,
        to_emails: job.to_emails || null,
        recipient_name: job.recipient_name || null,
        message_type: job.message_type || null,
        event_type: job.event_type || null,
        reference_id: job.reference_id || null,
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
      }).catch(e => console.error('webhook delivery failed', client.client_key, e));
    } else {
      await fetch(targetUrl.href, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
      }).catch(e => console.error('webhook delivery failed', client.client_key, e));
    }
  } catch (e) {
    console.error('dispatchWebhook', e);
  }
}
