/* =====================================================================
   ConnectX — system job puller (public-API / api_key systems)

   Systems whose integration mode is "api_key" (the EMS Public API v1
   contract: /api/v1 authenticated with an owner-issued `emsk_…` key)
   do NOT push messages into ConnectX. Instead ConnectX runs the
   dispatch loop documented in the system's API.md:

     every ~20 s:
       POST /api/v1/heartbeat            → shows ConnectX Online in EMS
       POST /api/v1/sms/claim {limit:8}  → queued jobs across ALL shops
       ... deliver through paired gateways ...
       POST /api/v1/sms/report           → {jobId, status, error}

   The loop is driven by the gateways themselves: every device poll
   (device/jobs/claim) triggers a throttled pull for the shop's system,
   so fresh EMS jobs land in the same poll cycle. A `scheduled` export
   in functions/api/[[path]].js runs the same pull for every api_key
   system when a Pages cron trigger is configured (optional).

   Results flow back in device/jobs/report (and job cancellation):
   jobs carrying external_job_id are reported to the system's
   /api/v1/sms/report endpoint, best effort.
   ===================================================================== */
import { all, get, insert, update } from './db.js';
import { uuid, nowIso, str } from './core.js';

const PULL_EVERY_MS = 20000;      // dispatch-loop cadence from the EMS API docs
const CLAIM_LIMIT = 8;            // jobs claimed per cycle (EMS caps at 20)
const PULL_TIMEOUT = 12000;       // per-call timeout for pull-loop requests

/** A system is pullable when it uses api_key mode and has URL + key. */
export function isPullMode(system) {
  return !!system && system.status === 'active' && system.auth_mode === 'api_key'
    && !!system.api_url && !!system.api_key;
}

/** Is this system's pull due? (throttles the piggyback on device polls) */
export function pullDue(system) {
  if (!isPullMode(system)) return false;
  if (!system.last_pull_at) return true;
  const last = new Date(system.last_pull_at).getTime();
  return !Number.isFinite(last) || Date.now() - last >= PULL_EVERY_MS;
}

async function apiFetch(env, system, path, options = {}) {
  const f = env.SYSTEM_FETCH || fetch;
  const base = String(system.api_url || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  if (!base) throw new Error('system api_url not configured');
  return f(`${base}/${p}`, {
    ...options,
    headers: { authorization: 'Bearer ' + system.api_key, ...(options.headers || {}) },
    signal: AbortSignal.timeout(PULL_TIMEOUT)
  });
}

/** Register a shop that appeared in the system's queue but was never synced. */
async function autoRegisterShop(env, system, externalId) {
  const shop = {
    id: uuid(), system_id: system.id, external_id: externalId,
    name: `${system.name} shop ${externalId.slice(0, 6)}`,
    shop_code: '', address: '', phone: '', category: '',
    system_status: 'active', status: 'active', created_at: nowIso(), updated_at: nowIso()
  };
  try {
    await insert(env, 'cx_shops', shop);
  } catch {
    const existing = await get(env, 'SELECT * FROM cx_shops WHERE system_id = ? AND external_id = ?', system.id, externalId);
    if (!existing) throw new Error(`shop ${externalId} could not be registered`);
    return existing;
  }
  return shop;
}

/**
 * One dispatch-loop cycle for a single api_key system:
 * heartbeat (best effort) + claim queued jobs + import them as cx_jobs.
 * Safe to call often — throttled by last_pull_at unless force is set.
 */
export async function pullSystemJobs(env, system, { force = false } = {}) {
  if (!isPullMode(system)) return { skipped: true };
  if (!force && !pullDue(system)) return { throttled: true };
  const out = { heartbeat: false, claimed: 0, imported: 0, error: null };
  try {
    // 1) heartbeat — marks the ConnectX service Online inside the system.
    try {
      const hb = await apiFetch(env, system, 'api/v1/heartbeat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      out.heartbeat = hb.ok;
    } catch { /* online state is best effort; the claim below matters */ }

    // 2) claim queued SMS jobs across every shop of the system.
    const res = await apiFetch(env, system, 'api/v1/sms/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: CLAIM_LIMIT })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(str(body.error || `HTTP ${res.status}`, 200));
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    out.claimed = jobs.length;

    // 3) import each claimed job as a queued ConnectX SMS job.
    for (const job of jobs) {
      const extJobId = str(job.id || '', 80);
      const extShopId = str(job.shop_id || '', 80);
      const phone = str(job.to_phone || job.phone_number || job.phone || '', 32);
      const message = str(job.message_body || job.message || '', 1000);
      if (!extJobId || !extShopId || !phone || !message) continue;
      const dup = await get(env,
        'SELECT id FROM cx_jobs WHERE system_id = ? AND external_job_id = ?', system.id, extJobId);
      if (dup) continue;   // already imported (e.g. EMS re-released a stale claim)
      let shop = await get(env,
        'SELECT * FROM cx_shops WHERE system_id = ? AND external_id = ?', system.id, extShopId);
      if (!shop) shop = await autoRegisterShop(env, system, extShopId);
      await insert(env, 'cx_jobs', {
        id: uuid(), shop_id: shop.id, system_id: system.id, api_key_id: null, channel: 'sms',
        to_phone: phone, recipient_name: job.recipient_name ? str(job.recipient_name, 160) : null,
        recipient_type: str(job.recipient_type || 'customer', 30),
        message_type: job.message_type ? str(job.message_type, 60) : null,
        event_type: job.event_type ? str(job.event_type, 60) : null,
        reference_id: job.invoice_id ? str(job.invoice_id, 80) : null,
        message_body: message, status: 'queued', attempts: 0, max_attempts: 3,
        external_job_id: extJobId, created_at: nowIso()
      });
      out.imported++;
    }
    await update(env, 'cx_systems',
      { last_pull_at: nowIso(), last_pull_error: null, updated_at: nowIso() }, 'id = ?', system.id).catch(() => {});
  } catch (e) {
    out.error = str((e && e.message) || e, 200);
    await update(env, 'cx_systems',
      { last_pull_at: nowIso(), last_pull_error: out.error, updated_at: nowIso() }, 'id = ?', system.id).catch(() => {});
  }
  return out;
}

/**
 * Report a finished job back to its originating api_key system
 * (EMS `/api/v1/sms/report`). Best effort — a failed report leaves the
 * job in "sending" there, and the system auto-releases it after 10 min;
 * the dedupe on external_job_id keeps ConnectX from double-sending.
 */
export async function reportJobToSystem(env, job, status, error) {
  if (!job || !job.external_job_id || !job.system_id) return;
  const system = await get(env, 'SELECT * FROM cx_systems WHERE id = ?', job.system_id);
  if (!isPullMode(system)) return;
  const sent = status === 'sent';
  try {
    await apiFetch(env, system, 'api/v1/sms/report', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: job.external_job_id,
        status: sent ? 'sent' : 'failed',
        ...(sent ? {} : { error: str(error || 'SMS could not be sent', 400) })
      })
    });
  } catch { /* best effort */ }
}

/** Best-effort "ConnectX service is online" ping (called at admin sign-in). */
export async function systemHeartbeat(env, system) {
  if (!isPullMode(system)) return;
  try {
    await apiFetch(env, system, 'api/v1/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
  } catch { /* online state is best effort */ }
}

/** Cron entry point: one forced cycle for every api_key system. */
export async function pullAllSystems(env) {
  const systems = await all(env,
    "SELECT * FROM cx_systems WHERE status = 'active' AND auth_mode = 'api_key'");
  const results = [];
  for (const s of systems) {
    if (!s.api_url || !s.api_key) continue;
    results.push({ system: s.system_key, ...(await pullSystemJobs(env, s, { force: true })) });
  }
  return results;
}
