/* Minimal ConnectX application identity retained for the legacy, authenticated
   device email-history bridge. It does not register phones or dispatch SMS. */
import { get, insert } from './db.js';
import { nowIso } from './core.js';
import { applicationId, normalizeEndpoint } from './connect_protocol.js';

function endpointFrom(request, override) {
  const saved = normalizeEndpoint(override);
  if (saved) return saved;
  try { return `${new URL(request.url).origin}/connect`; } catch { return ''; }
}

export async function ensureIdentity(env, request) {
  let row = null;
  try {
    row = await get(env, 'SELECT * FROM cx_connect_identity WHERE id = 1');
  } catch (error) {
    const message = String(error?.message || error);
    if (/no such table/i.test(message)) {
      return { ready: false, error: 'Connect App identity tables are not installed.' };
    }
    throw error;
  }
  if (!row) {
    row = {
      id: 1,
      application_id: applicationId('CONNECTX'),
      application_name: 'ConnectX',
      kind: 'gateway',
      endpoint_override: '',
      created_at: nowIso()
    };
    try { await insert(env, 'cx_connect_identity', row); }
    catch { row = await get(env, 'SELECT * FROM cx_connect_identity WHERE id = 1'); }
  }
  return { ready: true, ...row, connect_endpoint: endpointFrom(request, row.endpoint_override) };
}
