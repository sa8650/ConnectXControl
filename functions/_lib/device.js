/* =====================================================================
   ConnectX Device API — the ONLY backend the ConnectX Android gateway
   talks to. The app never stores or calls another product's URLs.

   Auth models:
   · Federated administrator — the phone user is an administrator of an
     integrated SYSTEM (EMS today; InfluenceOS, CareOS, PlugX...).
     Sign-in: app → ConnectX → that system's API (configured centrally
     on the control website). ConnectX then issues its own short-lived
     admin session token and syncs the administrator's shops.
   · Device token — opaque `cxd_...` (SHA-256 hash stored in cx_devices)
     for a paired gateway: claim/report/stats/emails.
   · Pairing code — account-free alternative generated on the website,
     bound to one shop.

   There is no workspace concept: a device belongs to a SHOP of a SYSTEM.
   ===================================================================== */
import { all, get, insert, update, run, parseJson } from './db.js';
import {
  json, fail, uuid, nowIso, str, bool, cleanPhone, isUuid, dayStart, onlineOf,
  signToken, verifyToken, bearerOf, sha256,
  deviceToken as newDeviceToken
} from './core.js';
import { logActivity } from './audit.js';
import { dispatchWebhook } from './webhook.js';
import { pullDue, pullSystemJobs, reportJobToSystem, systemHeartbeat } from './pull.js';

const ADMIN_TTL = 60 * 60 * 8;             // ConnectX admin sessions (aligns with system tokens)
const SYSTEM_CALL_TIMEOUT = 15000;         // server-to-server system API calls
const EMAIL_PAGE_SIZE = 30;

/* ---------- public shapes ---------- */
export function publicOperator(o) {
  if (!o) return null;
  return {
    id: o.id,
    admin_code: o.operator_code || null,
    name: o.name || '',
    email: o.email || '',
    phone: o.phone || '',
    address: o.address || '',
    role: o.role || 'operator',
    active: bool(o.active),
    created_at: o.created_at || null
  };
}

export function publicSystem(s) {
  if (!s) return null;
  return { id: s.id, key: s.system_key, name: s.name };
}

export function publicAdmin(a) {
  if (!a) return null;
  return {
    id: a.id,
    external_id: a.external_id || null,
    email: a.email || '',
    name: a.name || '',
    admin_code: a.admin_code || null
  };
}

export function publicShop(s) {
  if (!s) return null;
  return {
    id: s.id,
    external_id: s.external_id,
    name: s.name,
    shop_code: s.shop_code || '',
    address: s.address || '',
    phone: s.phone || '',
    category: s.category || '',
    status: s.status,
    system_status: s.system_status || 'active'
  };
}

export function publicDevice(d) {
  if (!d) return null;
  return {
    id: d.id,
    device_public_id: d.device_public_id,
    device_name: d.device_name,
    android_version: d.android_version,
    app_version: d.app_version || null,
    sim_subscription_id: d.sim_subscription_id,
    sim_carrier: d.sim_carrier,
    phone_number: d.phone_number,
    status: d.status,
    is_primary: bool(d.is_primary),
    last_seen: d.last_seen,
    created_at: d.created_at,
    shop_id: d.shop_id
  };
}

export function publicEmail(row, detail = false) {
  if (!row) return null;
  const addresses = v => { const a = parseJson(v, []); return Array.isArray(a) ? a.map(String) : []; };
  return {
    id: row.id,
    subject: row.subject || '',
    from_email: row.from_email || '',
    to_emails: addresses(row.to_emails),
    cc_emails: addresses(row.cc_emails),
    recipient_type: row.recipient_type || '',
    status: row.status || 'queued',
    error_message: row.error_message || null,
    created_at: row.created_at,
    sent_at: row.sent_at || null,
    ...(detail ? {
      bcc_emails: addresses(row.bcc_emails),
      custom_body: row.custom_body || '',
      body_html: row.body_html || ''
    } : {})
  };
}

/* ---------- system (federated) helpers ---------- */

/** Server-to-server call into an integrated system. Tests may inject env.SYSTEM_FETCH. */
async function systemFetch(env, system, path, options = {}) {
  const f = env.SYSTEM_FETCH || fetch;
  const base = String(system.api_url || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  if (!base) throw new Error('system api_url not configured');
  return f(`${base}/${p}`, { ...options, signal: AbortSignal.timeout(SYSTEM_CALL_TIMEOUT) });
}

/** Read `exp` (unix seconds) from an HS256 JWT payload without verifying it
    (verification already happened inside the issuing system). */
function jwtExp(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4);
    const claims = JSON.parse(atob(b64));
    return Number(claims.exp) > 0 ? Number(claims.exp) : null;
  } catch { return null; }
}

/** Upsert a list of shops reported by the system, then compose the
    administrator's shop view (shops + their gateway devices). */
async function composeAdminShops(env, system, admin, list, administratorOut) {
  for (const st of list) {
    const externalId = str(st.id || st.store_id || '', 80);
    if (!externalId) continue;
    await run(env,
      `INSERT INTO cx_shops (id, system_id, external_id, name, shop_code, address, phone, category, system_status, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(system_id, external_id) DO UPDATE SET
         name = excluded.name, shop_code = excluded.shop_code, address = excluded.address,
         phone = excluded.phone, category = excluded.category,
         system_status = excluded.system_status, updated_at = excluded.updated_at`,
      uuid(), system.id, externalId,
      str(st.name || externalId, 160), str(st.shop_code || '', 60), str(st.address || '', 240),
      str(st.phone || '', 32), str(st.category || '', 80), str(st.status || 'active', 20),
      nowIso(), nowIso());
  }
  // Every shop known for this system — including ones auto-registered by the client API.
  const rows = await all(env, 'SELECT * FROM cx_shops WHERE system_id = ? ORDER BY name ASC', system.id);
  const devices = await all(env,
    "SELECT * FROM cx_devices WHERE admin_id = ? AND status != 'revoked'", admin.id);
  const byShop = {};
  for (const d of devices) (byShop[d.shop_id] ||= []).push(publicDevice(d));
  return {
    administrator: administratorOut ? {
      id: admin.id,
      external_id: administratorOut.id || admin.external_id,
      admin_code: administratorOut.admin_code || admin.admin_code || null,
      name: administratorOut.name || admin.name || '',
      email: administratorOut.email || admin.email || ''
    } : publicAdmin(admin),
    shops: rows.map(s => ({
      ...publicShop(s),
      connected: (byShop[s.id] || []).some(d => d.status === 'active' || d.status === 'pending_test'),
      devices: byShop[s.id] || []
    }))
  };
}

/** Refresh the administrator's shops from the system.
    api_key mode : GET shops_path?admin_id=… with the stored platform key → {items:[…]}
    federated    : GET shops_path with the admin's system token          → {shops:[…]} */
async function syncAdminShops(env, system, admin) {
  const apiMode = system.auth_mode === 'api_key';
  if (apiMode && !system.api_key)
    return { error: fail(`${system.name} needs its API key stored in ConnectX Control before shops can sync.`, 503) };
  let res;
  try {
    const qs = apiMode && admin.external_id ? `?admin_id=${encodeURIComponent(admin.external_id)}` : '';
    res = await systemFetch(env, system, system.shops_path + qs, {
      headers: { authorization: 'Bearer ' + (apiMode ? system.api_key : admin.system_token) }
    });
  } catch {
    return { error: fail(`Could not reach ${system.name} to load shops. Check its API URL in ConnectX Control.`, 502) };
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403)
      return { error: fail(apiMode
        ? `${system.name} rejected the stored API key. The ConnectX owner should update it in Systems → Configure.`
        : `${system.name} session expired or was rejected. Please sign in again.`,
        apiMode ? 503 : 401) };
    return { error: fail(String(out.error || `${system.name} could not list shops.`).slice(0, 300), 502) };
  }
  const list = Array.isArray(out.items) ? out.items : Array.isArray(out.shops) ? out.shops : [];
  return composeAdminShops(env, system, admin, list, out.administrator || null);
}

/* ---------- sessions ---------- */
async function adminSession(env, request) {
  const payload = await verifyToken(bearerOf(request), env.SESSION_SECRET);
  if (!payload || payload.role !== 'system_admin') return null;
  const admin = await get(env, 'SELECT * FROM cx_admins WHERE id = ?', payload.id);
  if (!admin) return null;
  const system = await get(env, 'SELECT * FROM cx_systems WHERE id = ?', admin.system_id);
  if (!system || system.status !== 'active') return null;
  return { admin, system };
}

export async function deviceSession(env, request) {
  const token = bearerOf(request);
  if (!token.startsWith('cxd_')) return null;
  const hash = await sha256(token);
  const device = await get(env, 'SELECT * FROM cx_devices WHERE token_hash = ?', hash);
  if (!device || device.status === 'revoked') return null;
  return device;
}

async function touchDevice(env, deviceId, patch = {}) {
  await update(env, 'cx_devices', { last_seen: nowIso(), updated_at: nowIso(), ...patch }, 'id = ?', deviceId).catch(() => {});
}

async function shopFor(env, device) {
  return get(env, 'SELECT * FROM cx_shops WHERE id = ?', device.shop_id);
}

async function adminFor(env, device) {
  if (!device.admin_id) return null;
  return get(env, 'SELECT * FROM cx_admins WHERE id = ?', device.admin_id);
}

/* ---------- device registration / pairing (shared) ---------- */
async function createDevice(env, { shop, admin, b, viaPairing = false }) {
  const existing = await all(env,
    "SELECT id FROM cx_devices WHERE shop_id = ? AND status != 'revoked'", shop.id);
  const isPrimary = existing.length === 0 || bool(b.isPrimary);
  if (isPrimary) {
    await update(env, 'cx_devices', { is_primary: 0 }, 'shop_id = ? AND is_primary = 1', shop.id).catch(() => {});
  }
  const id = uuid();
  const token = newDeviceToken();
  const row = {
    id,
    shop_id: shop.id,
    admin_id: admin ? admin.id : null,
    device_public_id: 'CX-' + id.replaceAll('-', '').slice(0, 10).toUpperCase(),
    device_name: str(b.deviceName || b.device_name || 'Android gateway', 120),
    android_version: str(b.androidVersion || b.android_version || '', 40) || null,
    app_version: str(b.appVersion || b.app_version || '', 40) || null,
    sim_subscription_id: b.simSubscriptionId != null ? String(b.simSubscriptionId) : null,
    sim_carrier: str(b.simCarrier || b.sim_carrier || '', 80) || null,
    phone_number: str(b.phoneNumber || b.phone_number || '', 32) || null,
    status: 'pending_test',
    is_primary: isPrimary ? 1 : 0,
    token_hash: await sha256(token),
    last_seen: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso()
  };
  await insert(env, 'cx_devices', row);
  await logActivity(env, {
    actorType: admin ? 'admin' : 'system',
    actorId: admin ? admin.id : null,
    actorLabel: admin ? `${admin.name || admin.email}` : (viaPairing ? 'Pairing code' : 'System'),
    action: viaPairing ? 'pair gateway device' : 'register gateway device',
    entityType: 'device', entityId: id,
    meta: { device_name: row.device_name, shop: shop.name, phone: row.phone_number }
  });
  return { device: row, token };
}

/* ===================================================================== */
export async function deviceRoutes(ctx) {
  const { env, request, path, method, url } = ctx;
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  /* ---------------- system list (phone app "System" dropdown) ---------- */
  if (path === 'device/systems' && method === 'GET') {
    const rows = await all(env,
      "SELECT system_key, name, description, api_url, auth_mode, api_key, status FROM cx_systems WHERE status = 'active' ORDER BY created_at ASC");
    return json({
      systems: rows.map(r => ({
        key: r.system_key, name: r.name, description: r.description || '',
        // false → owner has not connected it yet (api_key systems also need their key stored)
        available: !!r.api_url && (r.auth_mode !== 'api_key' || !!r.api_key)
      }))
    });
  }

  /* ---------------- administrator sign-in (through the system) ----------
     Two integration modes, selected per system on the control website:
     · api_key   — the system's public API (EMS v1 contract): ConnectX
                   forwards email+password together with the owner-stored
                   platform key (emsk_…); the system answers
                   {ok, administrator, shops, entitlement} and issues NO
                   session token — ConnectX manages its own sessions.
     · federated — legacy: POST login_path {email,password} → {token,user},
                   then shops are fetched with that system token.        */
  if (path === 'device/auth/login' && method === 'POST') {
    const b = await body();
    const sysKey = str(b.system || b.systemKey || b.system_key || '', 60).toLowerCase();
    const email = str(b.email || b.userId || b.user_id || '').toLowerCase();
    const password = String(b.password || '');
    if (!sysKey) return fail('Select the system where your account is registered.', 400);
    if (!email || !password) return fail('Email and password are required.', 400);

    const system = await get(env, 'SELECT * FROM cx_systems WHERE system_key = ? OR id = ?', sysKey, sysKey);
    if (!system || system.status !== 'active') return fail('That system is not available in ConnectX.', 404);
    if (!system.api_url)
      return fail(`${system.name} is not connected yet. The ConnectX owner must configure its API URL first.`, 503);

    let adminFields, shopsList = null, administratorOut = null;
    if (system.auth_mode === 'api_key') {
      if (!system.api_key)
        return fail(`${system.name} uses API-key sign-in but no key is stored. The ConnectX owner must add the system API key in Systems → Configure.`, 503);
      let res;
      try {
        res = await systemFetch(env, system, system.login_path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + system.api_key },
          body: JSON.stringify({ email, password })
        });
      } catch {
        return fail(`Could not reach ${system.name}. The ConnectX owner should check its API URL.`, 502);
      }
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = String(out.error || `${system.name} rejected the sign-in.`).slice(0, 300);
        if (res.status === 401) return fail(msg, 401);
        if (res.status === 403)
          return fail(out.code === 'insufficient_scope'
            ? `${msg} The ConnectX owner must grant the API key the auth:login scope in ${system.name}.`
            : msg, 403);
        return fail(`${system.name} answered: ${msg}`, 502);
      }
      administratorOut = out.administrator || null;
      if (!administratorOut || !administratorOut.id)
        return fail(`${system.name} returned an unexpected response.`, 502);
      const ent = out.entitlement || null;
      if (ent && ent.connectx_enabled === false)
        return fail(`ConnectX is not enabled on your ${system.name} plan. The ${system.name} owner must enable it for your license.`, 403);
      adminFields = {
        external_id: str(administratorOut.id, 80),
        name: str(administratorOut.name || '', 160),
        admin_code: administratorOut.admin_code != null ? str(administratorOut.admin_code, 40) : null,
        system_token: null,                 // the system issues no session in this mode
        system_token_exp: null,
        last_login_at: nowIso()
      };
      shopsList = Array.isArray(out.shops) ? out.shops : [];
      // Show the ConnectX service Online in the system right away.
      ctx.waitUntil?.(systemHeartbeat(env, system));
    } else {
      let res;
      try {
        res = await systemFetch(env, system, system.login_path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
      } catch {
        return fail(`Could not reach ${system.name}. The ConnectX owner should check its API URL.`, 502);
      }
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const status = res.status === 401 ? 401 : res.status === 403 ? 403 : 502;
        const msg = String(out.error || `${system.name} rejected the sign-in.`).slice(0, 300);
        // Make it obvious the answer came from the external system, not ConnectX.
        return fail(status === 502 ? `${system.name} answered: ${msg}` : msg, status);
      }
      const systemToken = String(out.token || '');
      const user = out.user || {};
      if (!systemToken || !user.id) return fail(`${system.name} returned an unexpected response.`, 502);
      if (out.role && !['admin', 'owner'].includes(String(out.role)))
        return fail(`Administrator sign-in required for ${system.name}.`, 403);
      const exp = jwtExp(systemToken);
      adminFields = {
        external_id: str(user.id, 80),
        name: str(user.name || '', 160),
        admin_code: user.admin_code != null ? str(user.admin_code, 40) : null,
        system_token: systemToken,
        system_token_exp: exp
          ? new Date(exp * 1000).toISOString()
          : new Date(Date.now() + ADMIN_TTL * 1000).toISOString(),
        last_login_at: nowIso()
      };
    }

    // Upsert the local administrator mirror (no password is ever stored).
    const existing = await get(env, 'SELECT * FROM cx_admins WHERE system_id = ? AND email = ?', system.id, email);
    let admin;
    if (existing) {
      await update(env, 'cx_admins', adminFields, 'id = ?', existing.id);
      admin = { ...existing, ...adminFields };
    } else {
      admin = { id: uuid(), system_id: system.id, email, ...adminFields, created_at: nowIso() };
      await insert(env, 'cx_admins', admin);
    }

    // Load (and cache) this administrator's shops: straight from the login
    // answer in api_key mode, or a follow-up shops call in federated mode.
    const synced = shopsList
      ? await composeAdminShops(env, system, admin, shopsList, administratorOut)
      : await syncAdminShops(env, system, admin);
    if (synced.error) return synced.error;

    const token = await signToken(
      { id: admin.id, role: 'system_admin', system: system.id, email, exp: Math.floor(Date.now() / 1000) + ADMIN_TTL },
      env.SESSION_SECRET);
    await logActivity(env, {
      actorType: 'admin', actorId: admin.id, actorLabel: `${admin.name || email} via ${system.name}`,
      action: 'administrator sign-in', entityType: 'session', entityId: admin.id,
      meta: { system: system.system_key, shops: synced.shops.length, mode: system.auth_mode || 'federated' }
    });
    return json({
      token,
      admin: publicAdmin(admin),
      administrator: synced.administrator,        // richer shape echoed from the system
      system: publicSystem(system),
      shops: synced.shops
    });
  }

  /* ---------------- shop list refresh (admin session) ------------------ */
  if (path === 'device/shops' && method === 'GET') {
    const sess = await adminSession(env, request);
    if (!sess) return fail('Administrator sign-in required.', 403);
    // Federated mode rides on the system session token; api_key mode uses the
    // owner-stored platform key instead (no per-admin token exists there).
    if (sess.system.auth_mode !== 'api_key' &&
        (!sess.admin.system_token || new Date(sess.admin.system_token_exp || 0).getTime() < Date.now()))
      return fail(`${sess.system.name} session expired. Please sign in again.`, 401);
    const synced = await syncAdminShops(env, sess.system, sess.admin);
    if (synced.error) return synced.error;
    return json({ administrator: synced.administrator, system: publicSystem(sess.system), shops: synced.shops });
  }

  /* ---------------- pairing code (account-free phone pairing) ---------- */
  if (path === 'device/pair' && method === 'POST') {
    const b = await body();
    // Accept the code with or without its dash (4F7K-9Q2M / 4F7K9Q2M).
    let code = str(b.code || b.pairingCode || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const digits = code.replace(/-/g, '');
    if (digits.length === 8) code = `${digits.slice(0, 4)}-${digits.slice(4)}`;
    if (!code) return fail('Pairing code is required.', 400);
    const pair = await get(env, 'SELECT * FROM cx_pairing_codes WHERE code = ?', code);
    if (!pair || pair.used_at) return fail('This pairing code was already used. Generate a new one in ConnectX Control.', 404);
    if (new Date(pair.expires_at).getTime() < Date.now())
      return fail('This pairing code expired. Generate a new one in ConnectX Control.', 410);
    const shop = await get(env, 'SELECT * FROM cx_shops WHERE id = ?', pair.shop_id);
    if (!shop || shop.status !== 'active' || shop.system_status === 'inactive')
      return fail('That shop is not active.', 404);
    const system = await get(env, "SELECT * FROM cx_systems WHERE id = ? AND status = 'active'", shop.system_id);
    if (!system) return fail('The system for this pairing code is not active.', 404);
    const { device, token } = await createDevice(env, { shop, admin: null, b, viaPairing: true });
    await update(env, 'cx_pairing_codes', { used_at: nowIso(), device_id: device.id }, 'id = ?', pair.id).catch(() => {});
    return json({
      device: publicDevice(device),
      deviceToken: token,
      shop: publicShop(shop),
      system: publicSystem(system),
      administrator: null
    }, 201);
  }

  /* ---------------- device registration (admin session) ---------------- */
  if (path === 'device/register' && method === 'POST') {
    const sess = await adminSession(env, request);
    if (!sess) return fail('Administrator sign-in required.', 403);
    const b = await body();
    const shopId = str(b.shopId || b.shop_id || b.storeId || '');
    if (!shopId) return fail('Shop is required.', 400);
    const shop = await get(env, 'SELECT * FROM cx_shops WHERE id = ? OR external_id = ?', shopId, shopId);
    if (!shop || shop.system_id !== sess.system.id) return fail('Shop not found for this administrator.', 404);
    if (shop.status !== 'active') return fail('This shop is paused in ConnectX Control.', 403);
    if (shop.system_status === 'inactive') return fail('This shop is deactivated in ' + sess.system.name + '.', 403);
    const { device, token } = await createDevice(env, { shop, admin: sess.admin, b });
    return json({
      device: publicDevice(device),
      deviceToken: token,
      shop: publicShop(shop),
      system: publicSystem(sess.system),
      administrator: publicAdmin(sess.admin)
    }, 201);
  }

  /* =====================================================================
     Everything below requires a paired-device token.
     ===================================================================== */
  const device = await deviceSession(env, request);
  if (!device) {
    if (path.startsWith('device/')) return fail('Device not connected. Pair this phone again in ConnectX Control.', 403);
    return null;
  }
  const shop = await shopFor(env, device);
  if (!shop) return fail('The shop for this device was removed.', 403);
  if (shop.status !== 'active') return fail('This shop is paused. Resume it in ConnectX Control.', 403);
  if (shop.system_status === 'inactive') return fail('This shop is deactivated in its system.', 403);
  const system = await get(env, 'SELECT * FROM cx_systems WHERE id = ?', shop.system_id);

  if (path === 'device/me' && method === 'GET') {
    const admin = await adminFor(env, device);
    const adminDevices = await all(env,
      "SELECT shop_id FROM cx_devices WHERE status != 'revoked' AND admin_id = ?", device.admin_id || '');
    return json({
      device: publicDevice(device),
      shop: publicShop(shop),
      system: publicSystem(system),
      administrator: publicAdmin(admin),
      connectedShopIds: [...new Set(adminDevices.map(x => x.shop_id))]
    });
  }

  if (path === 'device/heartbeat' && method === 'POST') {
    const b = await body();
    const patch = { status: device.status === 'pending_test' ? 'pending_test' : 'active' };
    if (b.androidVersion) patch.android_version = str(b.androidVersion, 40);
    if (b.appVersion) patch.app_version = str(b.appVersion, 40);
    if (b.deviceName) patch.device_name = str(b.deviceName, 120);
    await touchDevice(env, device.id, patch);
    const admin = await adminFor(env, device);
    const settings = await get(env, "SELECT setting_value FROM cx_settings WHERE setting_key = 'sms'");
    const smsCfg = parseJson(settings?.setting_value, {}) || {};
    return json({
      ok: true,
      device: publicDevice({ ...device, ...patch, last_seen: nowIso() }),
      shop: publicShop(shop),
      system: publicSystem(system),
      administrator: publicAdmin(admin),
      smsEnabled: smsCfg.enabled !== false
    });
  }

  if (path === 'device/sim' && method === 'PATCH') {
    const b = await body();
    const patch = {};
    if (b.simSubscriptionId != null) patch.sim_subscription_id = String(b.simSubscriptionId);
    if (b.simCarrier != null) patch.sim_carrier = str(b.simCarrier, 80);
    if (b.phoneNumber != null) patch.phone_number = str(b.phoneNumber, 32);
    await touchDevice(env, device.id, patch);
    return json({ ok: true });
  }

  if (path === 'device/sim-carrier' && method === 'GET') {
    const params = url.searchParams;
    const numeric = str(params.get('mccMnc') || '').replace(/\D/g, '');
    const identifier = str(params.get('carrierName') || '').toLowerCase();
    if (numeric && !/^\d{5,6}$/.test(numeric)) return fail('Invalid MCC/MNC.', 400);
    if (!numeric && !identifier) return json({ supported: false });
    const rows = await all(env, 'SELECT * FROM cx_sim_carriers');
    const exact = numeric ? rows.find(r => r.mcc_mnc === numeric) : null;
    const byName = !exact && identifier
      ? rows.filter(r => !r.mcc_mnc && String(r.carrier_identifier || r.carrier_name || '').toLowerCase() === identifier)
      : [];
    const match = exact || (byName.length === 1 ? byName[0] : null);
    if (!match || !bool(match.active) || !match.balance_ussd_code) return json({ supported: false });
    return json({
      supported: true,
      carrier: {
        carrier_name: match.carrier_name,
        mcc_mnc: match.mcc_mnc,
        balance_ussd_code: match.balance_ussd_code,
        balance_pattern: match.balance_pattern
      }
    });
  }

  if (path === 'device/test' && method === 'POST') {
    const b = await body();
    await touchDevice(env, device.id, { status: b.ok === false ? 'pending_test' : 'active' });
    if (b.ok !== false && b.record !== false) {
      const phone = cleanPhone(b.phone || device.phone_number);
      if (phone) {
        await insert(env, 'cx_jobs', smsJobRow({
          shopId: shop.id, systemId: null, apiKeyId: null,
          phone, name: 'Test', recipientType: 'manual',
          messageType: 'TEST', eventType: 'TEST',
          messageBody: str(b.message || `ConnectX test from gateway ${device.device_name || ''}.`, 1000),
          idempotencyKey: `TEST:${device.id}:${Date.now()}`
        }));
      }
    }
    return json({ ok: true, status: b.ok === false ? 'pending_test' : 'active' });
  }

  if (path === 'device/disconnect' && method === 'POST') {
    await update(env, 'cx_devices', { status: 'revoked', is_primary: 0, token_hash: null, updated_at: nowIso() }, 'id = ?', device.id);
    await logActivity(env, {
      actorType: 'device', actorId: device.id, actorLabel: device.device_name,
      action: 'device disconnected itself', entityType: 'device', entityId: device.id
    });
    return json({ ok: true });
  }

  /* ---------------- SMS job cancellation (queued only) ----------------- */
  const cancelJob = async jobId => {
    if (!jobId) return fail('jobId is required.', 400);
    const job = await get(env, "SELECT * FROM cx_jobs WHERE id = ? AND shop_id = ? AND channel = 'sms'", jobId, shop.id);
    if (!job) return fail('SMS job not found for this shop.', 404);
    if (job.status !== 'queued') return fail('SMS is no longer queued. Refresh history before retrying.', 409);
    // Conditional guard: another gateway may claim the job between SELECT and UPDATE.
    const changes = await update(env, 'cx_jobs',
      { status: 'cancelled', error_message: 'Cancelled from gateway' },
      "id = ? AND shop_id = ? AND status = 'queued'", jobId, shop.id);
    if (!changes) return fail('SMS was already claimed by a gateway. Refresh history.', 409);
    ctx.waitUntil?.(dispatchWebhook(env, { ...job, status: 'cancelled' }, 'job.cancelled'));
    // A pulled job that never went out is reported failed back to its system.
    if (job.external_job_id) ctx.waitUntil?.(reportJobToSystem(env, job, 'failed', 'Cancelled in ConnectX before sending'));
    return json({ ok: true, cancelled: true });
  };
  if (path === 'device/jobs/cancel' && method === 'POST') {
    const b = await body();
    return cancelJob(str(b.jobId || b.id || ''));
  }
  if (path.startsWith('device/jobs/') && method === 'DELETE') {
    return cancelJob(decodeURIComponent(path.slice('device/jobs/'.length)));
  }

  /* ---------------- claim queued SMS jobs ------------------------------ */
  if (path === 'device/jobs/claim' && method === 'POST') {
    const b = await body();
    await touchDevice(env, device.id, { status: device.status === 'pending_test' ? 'pending_test' : 'active' });
    const limit = Math.min(20, Math.max(1, Number(b.limit || 8)));

    // Public-API (api_key) systems: run their dispatch loop here so jobs
    // queued on the system side arrive in this very poll (throttled ~20 s).
    if (shop.system_id) {
      const sys = await get(env, 'SELECT * FROM cx_systems WHERE id = ?', shop.system_id);
      if (pullDue(sys)) await pullSystemJobs(env, sys);
    }

    // Re-queue jobs stuck in "sending" for more than 10 minutes.
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await update(env, 'cx_jobs',
      { status: 'queued', claimed_at: null },
      "shop_id = ? AND channel = 'sms' AND status = 'sending' AND (claimed_at IS NULL OR claimed_at < ?)",
      shop.id, stale).catch(() => {});

    const queued = await all(env,
      `SELECT j.*, s.system_key, s.name AS system_name
         FROM cx_jobs j LEFT JOIN cx_systems s ON s.id = j.system_id
        WHERE j.shop_id = ? AND j.channel = 'sms' AND j.status = 'queued'
        ORDER BY j.created_at ASC LIMIT ?`, shop.id, limit);

    const claimed = [];
    for (const job of queued) {
      const attempts = Number(job.attempts || 0) + 1;
      const changes = await update(env, 'cx_jobs',
        { status: 'sending', device_id: device.id, claimed_at: nowIso(), attempts },
        "id = ? AND shop_id = ? AND status = 'queued'", job.id, shop.id).catch(() => 0);
      // Only dispatch jobs this device actually won the claim race for.
      if (changes > 0) {
        claimed.push({
          id: job.id,
          shop_id: shop.id,
          shop_external_id: shop.external_id,
          administrator_id: device.admin_id,
          phone_number: job.to_phone,
          message: job.message_body,
          event_type: job.event_type || job.message_type,
          message_type: job.message_type,
          recipient_name: job.recipient_name,
          invoice_id: job.reference_id,        // legacy key kept for the phone app
          reference_id: job.reference_id,
          reference_number: job.reference_number,
          system_key: job.system_key || null,
          system_name: job.system_name || null,
          created_at: job.created_at,
          attempts
        });
      }
    }
    return json({ jobs: claimed });
  }

  /* ---------------- report send result --------------------------------- */
  if (path === 'device/jobs/report' && method === 'POST') {
    const b = await body();
    const id = str(b.jobId || b.id || '');
    if (!id) return fail('jobId is required.', 400);
    const status = b.status === 'sent' ? 'sent' : 'failed';
    const job = await get(env, "SELECT * FROM cx_jobs WHERE id = ? AND shop_id = ? AND channel = 'sms'", id, shop.id);
    if (!job) return fail('SMS job not found for this shop.', 404);
    if (job.device_id && job.device_id !== device.id && job.status === 'sent')
      return json({ ok: true, duplicate: true });
    const patch = {
      status,
      device_id: device.id,
      error_message: status === 'failed' ? str(b.error || 'SMS could not be sent', 400) : null
    };
    if (status === 'sent') patch.sent_at = nowIso();
    await update(env, 'cx_jobs', patch, 'id = ? AND shop_id = ?', id, shop.id);
    await touchDevice(env, device.id, { status: 'active' });
    ctx.waitUntil?.(dispatchWebhook(env, { ...job, ...patch }, status === 'sent' ? 'job.sent' : 'job.failed'));
    // Jobs pulled from a public-API system report their result back to it.
    if (job.external_job_id) ctx.waitUntil?.(reportJobToSystem(env, job, status, patch.error_message));
    return json({ ok: true, status });
  }

  /* ---------------- stats & activity ----------------------------------- */
  if (path === 'device/stats' && method === 'GET') {
    const today = dayStart(url.searchParams.get('utcOffsetMinutes'));
    if (!today) return fail('Invalid UTC offset.', 400);
    const [jobs, sentToday, last] = await Promise.all([
      all(env, "SELECT id, status, sent_at, created_at FROM cx_jobs WHERE shop_id = ? AND channel = 'sms' AND created_at >= ?", shop.id, today),
      all(env, "SELECT id FROM cx_jobs WHERE shop_id = ? AND channel = 'sms' AND status = 'sent' AND sent_at >= ?", shop.id, today),
      all(env, "SELECT created_at, sent_at, status FROM cx_jobs WHERE shop_id = ? AND channel = 'sms' ORDER BY created_at DESC LIMIT 1", shop.id)
    ]);
    await touchDevice(env, device.id);
    const admin = await adminFor(env, device);
    return json({
      sent: sentToday.length + jobs.filter(j => j.status === 'sent' && !j.sent_at).length,
      failed: jobs.filter(j => j.status === 'failed').length,
      pending: jobs.filter(j => j.status === 'queued' || j.status === 'sending').length,
      lastActivity: last[0]?.sent_at || last[0]?.created_at || null,
      device: publicDevice(device),
      shop: publicShop(shop),
      system: publicSystem(system),
      administrator: publicAdmin(admin)
    });
  }

  if (path === 'device/activity' && method === 'GET') {
    const range = url.searchParams.get('range') || 'today';
    const days = range === '30d' || range === '30' ? 30 : range === '7d' || range === '7' ? 7 : 1;
    const since = range === 'today' ? dayStart(url.searchParams.get('utcOffsetMinutes')) : new Date(Date.now() - days * 86400000).toISOString();
    if (!since) return fail('Invalid UTC offset.', 400);
    const rows = await all(env,
      `SELECT j.*, s.name AS system_name FROM cx_jobs j LEFT JOIN cx_systems s ON s.id = j.system_id
        WHERE j.shop_id = ? AND j.channel = 'sms' AND j.created_at >= ?
        ORDER BY j.created_at DESC LIMIT 250`, shop.id, since);
    return json({
      shop_id: shop.id,
      items: rows.map(r => ({
        id: r.id,
        to_phone: r.to_phone,
        recipient_name: r.recipient_name,
        message_type: r.message_type,
        event_type: r.event_type,
        status: r.status,
        error_message: r.error_message,
        message_body: r.message_body,
        created_at: r.created_at,
        sent_at: r.sent_at,
        invoice_id: r.reference_id,          // legacy key kept for the phone app
        invoice_number: r.reference_number,
        system_name: r.system_name || null
      }))
    });
  }

  /* ---------------- email history (channel='email' jobs) --------------- */
  if (method === 'GET' && (path === 'device/emails' || path === 'device/emails/stats' || path.startsWith('device/emails/'))) {
    if (device.status !== 'active') return fail('Complete device setup before viewing email.', 403);
    const visible = "shop_id = ? AND channel = 'email'";

    if (path === 'device/emails/stats') {
      const today = dayStart(url.searchParams.get('utcOffsetMinutes'));
      if (!today) return fail('Invalid UTC offset.', 400);
      const [todayRows, sentToday, latest] = await Promise.all([
        all(env, `SELECT status, sent_at FROM cx_jobs WHERE ${visible} AND created_at >= ?`, shop.id, today),
        all(env, `SELECT id FROM cx_jobs WHERE ${visible} AND status = 'sent' AND sent_at >= ?`, shop.id, today),
        all(env, `SELECT * FROM cx_jobs WHERE ${visible} ORDER BY created_at DESC, id DESC LIMIT 1`, shop.id)
      ]);
      return json({
        sent: sentToday.length + todayRows.filter(r => r.status === 'sent' && !r.sent_at).length,
        failed: todayRows.filter(r => r.status === 'failed').length,
        pending: todayRows.filter(r => r.status === 'queued' || r.status === 'sending').length,
        latest: publicEmail(latest[0])
      });
    }

    if (path === 'device/emails') {
      const rawPage = url.searchParams.get('page') || '0';
      if (!/^(0|[1-9][0-9]{0,4})$/.test(rawPage) || Number(rawPage) > 10000) return fail('Invalid email history page.', 400);
      const page = Number(rawPage);
      const snapshot = url.searchParams.get('snapshot') || (page === 0 ? nowIso() : '');
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(snapshot) || !Number.isFinite(Date.parse(snapshot)))
        return fail('Invalid email history snapshot.', 400);
      const rows = await all(env,
        `SELECT * FROM cx_jobs WHERE ${visible} AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        shop.id, snapshot, EMAIL_PAGE_SIZE + 1, page * EMAIL_PAGE_SIZE);
      return json({
        items: rows.slice(0, EMAIL_PAGE_SIZE).map(r => publicEmail(r)),
        page,
        hasMore: rows.length > EMAIL_PAGE_SIZE,
        snapshot
      });
    }

    const id = path.slice('device/emails/'.length);
    if (!isUuid(id)) return fail('Invalid email ID.', 400);
    const message = await get(env, `SELECT * FROM cx_jobs WHERE ${visible} AND id = ?`, shop.id, id);
    if (!message) return fail('Email not found for this shop.', 404);
    return json(publicEmail(message, true));
  }

  return fail('Unknown ConnectX device endpoint.', 404);
}

/* ---------- job row factory (shared with the client API) ---------- */
export function smsJobRow({
  shopId, systemId = null, apiKeyId = null, phone, name = null, recipientId = null,
  recipientType = 'customer', messageType = null, eventType = null, referenceId = null,
  referenceNumber = null, messageBody, idempotencyKey = null, maxAttempts = 3
}) {
  return {
    id: uuid(),
    shop_id: shopId,
    system_id: systemId,
    api_key_id: apiKeyId,
    channel: 'sms',
    to_phone: phone,
    recipient_type: recipientType || 'customer',
    recipient_id: recipientId || null,
    recipient_name: name ? str(name, 160) : null,
    message_type: messageType ? str(messageType, 80) : (eventType ? str(eventType, 80) : 'SMS'),
    event_type: eventType ? str(eventType, 80) : (messageType ? str(messageType, 80) : null),
    reference_id: referenceId || null,
    reference_number: referenceNumber ? str(referenceNumber, 80) : null,
    message_body: messageBody,
    status: 'queued',
    attempts: 0,
    max_attempts: maxAttempts,
    idempotency_key: idempotencyKey || null,
    created_at: nowIso()
  };
}

export { onlineOf };
