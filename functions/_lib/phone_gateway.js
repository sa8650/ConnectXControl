/* Authenticated compatibility bridge for legacy phone email history only.
   Pairing, phone enrollment, SMS jobs, heartbeat, and result reporting are
   retired here; new ConnectX Android devices connect directly to EMS. */
import { get } from './db.js';
import { json, fail, verifyToken, bearerOf, dayStart, nowIso } from './core.js';
import { ensureIdentity } from './connect_identity.js';
import { signEnvelope, postConnect } from './connect_protocol.js';

async function legacyEmailDevice(env, request) {
  const payload = await verifyToken(bearerOf(request), env.SESSION_SECRET);
  if (!payload || payload.role !== 'phone' || !payload.id) return null;
  const device = await get(env, 'SELECT * FROM cx_phone_devices WHERE id = ?', payload.id);
  if (!device || device.status === 'disconnected') return null;
  const connection = await get(env,
    "SELECT * FROM cx_connect_connections WHERE id = ? AND status IN ('ACTIVE', 'PAUSED')",
    device.connection_id);
  if (!connection) return null;
  return { device, connection };
}

async function callConnectedSystem(env, connection, action, payload) {
  const identity = await ensureIdentity(env, { url: 'https://connectxweb.pages.dev/connect' });
  if (!identity.ready) return { httpOk: false, status: 503, data: { error: identity.error } };
  const envelope = await signEnvelope({
    action,
    applicationId: identity.application_id,
    connectionId: connection.id,
    secret: connection.shared_secret,
    payload
  });
  return postConnect(connection.remote_endpoint, envelope);
}

export async function phoneGatewayRoutes(ctx) {
  const { env, request, path, method, url } = ctx;
  const isEmailHistory = path === 'device/emails' || path.startsWith('device/emails/');
  if (!isEmailHistory) return null;
  if (method !== 'GET') return fail('Legacy email history is read-only.', 405);

  const session = await legacyEmailDevice(env, request);
  if (!session) return fail('Sign in again to use this phone.', 401);
  const { device, connection } = session;
  const shared = { admin_id: device.admin_id, shop_id: device.shop_id };

  if (path === 'device/emails/stats') {
    const since = dayStart(url.searchParams.get('utcOffsetMinutes'));
    const response = await callConnectedSystem(env, connection, 'APP_EMAILS', { op: 'stats', ...shared, since });
    if (!response.httpOk || response.data?.ok === false)
      return fail(response.data?.error || 'Email history is unavailable.', 502);
    return json({
      sent: response.data.sent || 0,
      failed: response.data.failed || 0,
      pending: response.data.pending || 0,
      latest: response.data.latest || null
    });
  }

  if (path === 'device/emails') {
    const page = Math.max(0, Math.min(10000, Math.floor(Number(url.searchParams.get('page') || 0))));
    const response = await callConnectedSystem(env, connection, 'APP_EMAILS', { op: 'page', ...shared, page });
    if (!response.httpOk || response.data?.ok === false)
      return fail(response.data?.error || 'Email history is unavailable.', 502);
    return json({
      items: response.data.items || [],
      page: response.data.page || 0,
      snapshot: response.data.snapshot || nowIso(),
      hasMore: !!response.data.hasMore
    });
  }

  const emailId = decodeURIComponent(path.slice('device/emails/'.length));
  if (!emailId || emailId === 'stats') return fail('Email record not found.', 404);
  const response = await callConnectedSystem(env, connection, 'APP_EMAILS', {
    op: 'detail', ...shared, email_id: emailId
  });
  if (!response.httpOk || response.data?.ok === false)
    return fail(response.data?.error || 'Email not found.', response.status === 404 ? 404 : 502);
  return json(response.data.email || {});
}
