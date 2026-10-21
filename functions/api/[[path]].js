/* =====================================================================
   ConnectX Control — management, email settings, audit, and app releases.

   SMS delivery is EMS-direct: EMS owns the durable queue and ConnectX
   Android authenticates to EMS over HTTPS. Legacy Control relay, pairing,
   queue, and device-dispatch routes deliberately return 410. The authenticated
   legacy client email API remains email-only.

   /api/control/*   Control website (operator/owner bearer sessions)
   /api/public/*    Unauthenticated release check/download
   ===================================================================== */
import { controlRoutes } from '../_lib/control.js';
import { clientRoutes } from '../_lib/client.js';
import { publicReleaseRoutes } from '../_lib/releases.js';
import { phoneGatewayRoutes } from '../_lib/phone_gateway.js';
import { telemetryRoutes } from '../_lib/telemetry.js';
import { json, fail } from '../_lib/core.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD',
  'access-control-allow-headers': 'authorization, content-type, x-connectx-key, cache-control',
  'access-control-max-age': '86400'
};

function withCors(response) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function onRequest(context) {
  const { request, env, next, waitUntil } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

  // Non-API requests fall through to the static SPA (Pages asset handling).
  if (!url.pathname.startsWith('/api/')) return next();

  const path = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
  const ctx = { env, request, path, method, url, waitUntil, context };

  try {
    const emailHistoryPath = path === 'device/emails' || path.startsWith('device/emails/');
    const clientEmailPath = path === 'client/v1/email' || path === 'client/v1/email/send' ||
      /^client\/v1\/email\/[^/]+$/.test(path);
    const readOnlyMonitoringPath = method === 'GET' &&
      ['control/dashboard', 'control/devices', 'control/phones', 'control/jobs'].includes(path);
    const legacyDispatchPath = path === 'connect' || path.startsWith('connect/') ||
      path === 'device' || (path.startsWith('device/') && !emailHistoryPath) ||
      path === 'client' || (path.startsWith('client/') && !clientEmailPath) ||
      path === 'control/connect' || path.startsWith('control/connect/') ||
      (path === 'control/phones' && !readOnlyMonitoringPath) || path.startsWith('control/phones/') ||
      (path === 'control/devices' && !readOnlyMonitoringPath) || path.startsWith('control/devices/') ||
      (path === 'control/jobs' && !readOnlyMonitoringPath) || path.startsWith('control/jobs/') ||
      path === 'control/systems' || path.startsWith('control/systems/') ||
      path === 'control/keys' || path.startsWith('control/keys/') ||
      path === 'control/shops' || path.startsWith('control/shops/') ||
      (path === 'control/dashboard' && !readOnlyMonitoringPath);
    if (legacyDispatchPath) return withCors(fail(
      'This legacy Control systems, shops, pairing, SMS queue, and device-dispatch API is retired. EMS owns SMS delivery; sign in to EMS to manage devices and message history.',
      410
    ));

    if (!env || !env.DB) return withCors(fail('ConnectX database (D1 binding DB) is not configured. See DEPLOY.md.', 503));
    if (!env.SESSION_SECRET) return withCors(fail('SESSION_SECRET is not configured. Run: wrangler pages secret put SESSION_SECRET', 503));

    let response = null;
    if (path.startsWith('telemetry/')) response = await telemetryRoutes(ctx);
    else if (emailHistoryPath) response = await phoneGatewayRoutes(ctx);
    else if (clientEmailPath) response = await clientRoutes(ctx);
    else if (path.startsWith('control/')) response = await controlRoutes(ctx);
    else if (path.startsWith('public/')) response = await publicReleaseRoutes(ctx);
    else if (path === '' || path === 'health') response = json({ ok: true, service: 'connectx-control', version: '3.0.0', sms_delivery: 'ems-direct' });
    else response = fail('Unknown ConnectX API endpoint.', 404);

    return withCors(response || fail('Unknown ConnectX API endpoint.', 404));
  } catch (error) {
    console.error('ConnectX API error:', path, error);
    const msg = String(error?.message || error);
    if (/no such table: cx_/.test(msg) || /no such column: (shop_id|system_id|admin_id|external_id)/.test(msg))
      return withCors(fail('The ConnectX database schema is missing required tables or columns. Back up D1, then initialize it with npm run db:reset:remote — see DEPLOY.md.', 503));
    return withCors(fail('Internal ConnectX error: ' + msg, 500));
  }
}

/* There is intentionally no ConnectX SMS dispatch cron. */
