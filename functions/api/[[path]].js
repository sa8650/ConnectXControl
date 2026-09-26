/* =====================================================================
   ConnectX Control — API router (Cloudflare Pages Functions)

   /api/control/*   Control website (operator/owner bearer sessions)
   /api/device/*    ConnectX Android gateway (operator tokens + device tokens)
   /api/client/v1/* External products: EMS, CareOS, InfluenceOS, PlugX...
                    (X-ConnectX-Key API keys)
   /api/public/*    Unauthenticated: health + release check/download

   There is NO dependency on EMS: no EMS database, no EMS URLs, no EMS
   sessions. ConnectX is the source of truth for its own platform.
   ===================================================================== */
import { controlRoutes } from '../_lib/control.js';
import { deviceRoutes } from '../_lib/device.js';
import { clientRoutes } from '../_lib/client.js';
import { publicReleaseRoutes } from '../_lib/releases.js';
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
    if (!env || !env.DB) return withCors(fail('ConnectX database (D1 binding DB) is not configured. See DEPLOY.md.', 503));
    if (!env.SESSION_SECRET) return withCors(fail('SESSION_SECRET is not configured. Run: wrangler pages secret put SESSION_SECRET', 503));

    let response = null;
    if (path.startsWith('control/')) response = await controlRoutes(ctx);
    else if (path.startsWith('device/')) response = await deviceRoutes(ctx);
    else if (path.startsWith('client/')) response = await clientRoutes(ctx);
    else if (path.startsWith('public/')) response = await publicReleaseRoutes(ctx);
    else if (path === '' || path === 'health') response = json({ ok: true, service: 'connectx-control', version: '2.0.0' });
    else response = fail('Unknown ConnectX API endpoint.', 404);

    return withCors(response || fail('Unknown ConnectX API endpoint.', 404));
  } catch (error) {
    console.error('ConnectX API error:', path, error);
    return withCors(fail('Internal ConnectX error: ' + String(error?.message || error), 500));
  }
}
