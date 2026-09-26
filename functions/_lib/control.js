/* =====================================================================
   ConnectX Control API — backend for the control website.
   Operator/owner sessions (HMAC bearer tokens) manage SYSTEM integrations
   (EMS, InfluenceOS, CareOS, PlugX...), shops synced from those systems,
   gateway devices, message jobs, API keys, releases, SIM carrier catalog,
   the email gateway, platform settings and the audit trail.
   ===================================================================== */
import { all, get, insert, update, run, parseJson } from './db.js';
import {
  json, fail, uuid, nowIso, str, bool, cleanPhone, isEmail, isUuid, isVersion, isPackage,
  dayStart, onlineOf, signToken, verifyToken, bearerOf, hashPassword, checkPassword,
  sha256, clientApiKey, pairingCode, maskSecret, DEFAULT_TEMPLATES
} from './core.js';
import { reportJobToSystem } from './pull.js';
import { logActivity, recentActivity } from './audit.js';
import { publicOperator, publicShop, publicSystem, publicDevice, smsJobRow } from './device.js';
import { apkKey, getReleaseBucket, releaseStatus, downloadPath } from './releases.js';
import { emailConfig, providerList, sendEmail } from './email.js';

const CONTROL_TTL = 60 * 60 * 12; // 12h control-panel sessions
/* Integration modes:
   · api_key   — the system exposes a public API authenticated with an
                 owner-issued platform key (EMS v1: /api/v1 + emsk_ key).
                 Sign-in forwards credentials WITH the key; ConnectX also
                 pulls queued SMS from the system (functions/_lib/pull.js).
   · federated — legacy: admin-password login returns a system session
                 token used for the shops call.                            */
const MODE_DEFAULTS = {
  api_key:   { login_path: 'api/v1/auth/login',       shops_path: 'api/v1/shops' },
  federated: { login_path: 'api/auth/admin/login',    shops_path: 'api/connectx/gateway/shops' }
};
const SEED_SYSTEMS = [
  { key: 'ems', name: 'EMS', auth_mode: 'api_key',
    description: 'Enterprise Management Software — administrators sign in with their EMS account through the EMS Public API (v1). Needs the owner-issued emsk_ API key with scopes: auth:login, shops:read, sms:read, sms:write.' },
  { key: 'influenceos', name: 'InfluenceOS', description: 'InfluenceOS platform integration (connect its API URL when ready).' },
  { key: 'careos', name: 'CareOS', description: 'CareOS platform integration (connect its API URL when ready).' },
  { key: 'plugx', name: 'PlugX', description: 'PlugX platform integration (connect its API URL when ready).' }
];

/** Safe external shape of a cx_systems row — the stored api_key NEVER leaves. */
function safeSystem(s) {
  if (!s) return null;
  const { api_key, ...rest } = s;
  return {
    ...rest,
    api_key_set: !!api_key, api_key_hint: maskSecret(api_key),
    configured: !!rest.api_url && (rest.auth_mode !== 'api_key' || !!api_key)
  };
}

/* ---------- session ---------- */
async function controlSession(env, request) {
  const payload = await verifyToken(bearerOf(request), env.SESSION_SECRET);
  if (!payload || !['owner', 'operator'].includes(payload.role)) return null;
  const op = await get(env, 'SELECT * FROM cx_operators WHERE id = ?', payload.id);
  if (!op || !bool(op.active)) return null;
  return op;
}
const ownerOnly = op => op.role === 'owner';

async function auditOp(env, op, action, entityType, entityId, meta) {
  await logActivity(env, {
    actorType: 'operator', actorId: op.id, actorLabel: `${op.name} (${op.role})`,
    action, entityType, entityId, meta
  });
}

function validHttpUrl(v) {
  try { const u = new URL(String(v)); return u.protocol === 'https:' || u.protocol === 'http:'; }
  catch { return false; }
}

/* ===================================================================== */
export async function controlRoutes(ctx) {
  const { env, request, path, method, url } = ctx;
  const body = async () => { try { return await request.json(); } catch { return {}; } };

  /* ---------------- first-run bootstrap ------------------------------- */
  if (path === 'control/bootstrap' && method === 'GET') {
    const op = await get(env, 'SELECT id FROM cx_operators LIMIT 1');
    return json({ initialized: !!op, service: 'connectx-control' });
  }

  if (path === 'control/setup' && method === 'POST') {
    const existing = await get(env, 'SELECT id FROM cx_operators LIMIT 1');
    if (existing) return fail('ConnectX Control is already initialized. Sign in instead.', 403);
    const b = await body();
    const name = str(b.name || '', 120);
    const email = str(b.email || '').toLowerCase();
    const password = String(b.password || '');
    if (!name || !isEmail(email)) return fail('Enter your name and a valid email address.', 400);
    if (password.length < 10) return fail('Use a password of at least 10 characters.', 400);

    const id = uuid();
    await insert(env, 'cx_operators', {
      id, name, email, phone: str(b.phone || '', 32), address: str(b.address || '', 240),
      operator_code: 'CX-' + id.replaceAll('-', '').slice(0, 6).toUpperCase(),
      password_hash: await hashPassword(password), role: 'owner', active: 1,
      created_at: nowIso(), updated_at: nowIso()
    });
    // Seed the known systems once. Their API URLs are configured later on
    // the Systems page — until then phones see them as "not connected yet".
    for (const s of SEED_SYSTEMS) {
      const dup = await get(env, 'SELECT id FROM cx_systems WHERE system_key = ?', s.key);
      if (!dup) {
        const mode = s.auth_mode === 'api_key' ? 'api_key' : 'federated';
        const def = MODE_DEFAULTS[mode];
        await insert(env, 'cx_systems', {
          id: uuid(), system_key: s.key, name: s.name, description: s.description,
          api_url: '', auth_mode: mode, api_key: '',
          login_path: s.login_path || def.login_path, shops_path: s.shops_path || def.shops_path,
          webhook_url: null, status: 'active',
          last_pull_at: null, last_pull_error: null,
          created_at: nowIso(), updated_at: nowIso()
        });
      }
    }
    await logActivity(env, { actorType: 'system', action: 'platform initialized', entityType: 'operator', entityId: id });
    const token = await signToken({ id, role: 'owner', email, exp: Math.floor(Date.now() / 1000) + CONTROL_TTL }, env.SESSION_SECRET);
    const op = await get(env, 'SELECT * FROM cx_operators WHERE id = ?', id);
    return json({ token, operator: publicOperator(op) }, 201);
  }

  /* ---------------- auth ---------------------------------------------- */
  if (path === 'control/auth/login' && method === 'POST') {
    const b = await body();
    const email = str(b.email || '').toLowerCase();
    const op = await get(env, 'SELECT * FROM cx_operators WHERE email = ?', email);
    if (!op) return fail('Wrong email or password.', 401);
    if (!bool(op.active)) return fail('This account is deactivated.', 403);
    if (!await checkPassword(b.password || '', op.password_hash)) return fail('Wrong email or password.', 401);
    await update(env, 'cx_operators', { last_login_at: nowIso() }, 'id = ?', op.id).catch(() => {});
    const token = await signToken({ id: op.id, role: op.role, email: op.email, exp: Math.floor(Date.now() / 1000) + CONTROL_TTL }, env.SESSION_SECRET);
    await logActivity(env, { actorType: 'operator', actorId: op.id, actorLabel: op.name, action: 'sign in', entityType: 'session', entityId: op.id });
    return json({ token, operator: publicOperator(op) });
  }

  /* everything below needs a session */
  const op = await controlSession(env, request);
  if (!op) return fail('Please sign in to ConnectX Control.', 401);

  if (path === 'control/auth/me' && method === 'GET') return json({ operator: publicOperator(op) });

  if (path === 'control/auth/password' && method === 'PATCH') {
    const b = await body();
    if (!await checkPassword(b.currentPassword || '', op.password_hash)) return fail('Current password is wrong.', 403);
    if (String(b.newPassword || '').length < 10) return fail('New password must be at least 10 characters.', 400);
    await update(env, 'cx_operators', { password_hash: await hashPassword(b.newPassword), updated_at: nowIso() }, 'id = ?', op.id);
    await auditOp(env, op, 'change password', 'operator', op.id);
    return json({ ok: true });
  }

  if (path === 'control/auth/profile' && method === 'PATCH') {
    const b = await body();
    const patch = { updated_at: nowIso() };
    if (b.name !== undefined) patch.name = str(b.name, 120) || op.name;
    if (b.phone !== undefined) patch.phone = str(b.phone, 32);
    if (b.address !== undefined) patch.address = str(b.address, 240);
    await update(env, 'cx_operators', patch, 'id = ?', op.id);
    const fresh = await get(env, 'SELECT * FROM cx_operators WHERE id = ?', op.id);
    return json({ operator: publicOperator(fresh) });
  }

  /* ---------------- dashboard ----------------------------------------- */
  if (path === 'control/dashboard' && method === 'GET') {
    const today = dayStart(url.searchParams.get('utcOffsetMinutes')) || new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
    const [jobs, devices, systems, shops, recent, bySystemRows] = await Promise.all([
      all(env, 'SELECT id, channel, status, system_id, shop_id, created_at FROM cx_jobs WHERE created_at >= ?', today),
      all(env, "SELECT id, status, last_seen, shop_id FROM cx_devices WHERE status != 'revoked'"),
      all(env, 'SELECT id, name, system_key, status, api_url FROM cx_systems'),
      all(env, 'SELECT id, name, status FROM cx_shops'),
      all(env, `SELECT j.*, s.name AS system_name, sh.name AS shop_name, sh.external_id AS shop_external_id
                  FROM cx_jobs j LEFT JOIN cx_systems s ON s.id = j.system_id
                  LEFT JOIN cx_shops sh ON sh.id = j.shop_id
                 ORDER BY j.created_at DESC LIMIT 12`),
      all(env, 'SELECT system_id, status, COUNT(*) AS n FROM cx_jobs WHERE created_at >= ? GROUP BY system_id, status', today)
    ]);
    const count = (ch, sts) => jobs.filter(j => j.channel === ch && sts.includes(j.status)).length;
    const systemMap = Object.fromEntries(systems.map(s => [s.id, s]));
    const bySystem = {};
    for (const r of bySystemRows) {
      const s = systemMap[r.system_id] || { name: 'Console / Device', system_key: null };
      const keyName = s.name || 'Unknown';
      bySystem[keyName] ||= { sent: 0, failed: 0, pending: 0 };
      if (r.status === 'sent') bySystem[keyName].sent += r.n;
      else if (r.status === 'failed') bySystem[keyName].failed += r.n;
      else if (['queued', 'sending'].includes(r.status)) bySystem[keyName].pending += r.n;
    }
    return json({
      today: {
        smsSent: count('sms', ['sent']), smsFailed: count('sms', ['failed']),
        smsPending: count('sms', ['queued', 'sending']),
        emailSent: count('email', ['sent']), emailFailed: count('email', ['failed']),
        emailPending: count('email', ['queued', 'sending'])
      },
      devices: {
        total: devices.length,
        online: devices.filter(d => onlineOf(d.last_seen) && d.status === 'active').length,
        pendingTest: devices.filter(d => d.status === 'pending_test').length
      },
      shops: { total: shops.length, active: shops.filter(w => w.status === 'active').length },
      systems: {
        total: systems.length,
        active: systems.filter(s => s.status === 'active').length,
        connected: systems.filter(s => s.status === 'active' && s.api_url).length
      },
      bySystem,
      recentJobs: recent.map(j => ({
        id: j.id, channel: j.channel, status: j.status,
        to: j.channel === 'sms' ? j.to_phone : (parseJson(j.to_emails, []) || []).join(', '),
        recipient_name: j.recipient_name, message_type: j.message_type,
        system_name: j.system_name || 'Console', shop_name: j.shop_name, shop_external_id: j.shop_external_id,
        created_at: j.created_at, sent_at: j.sent_at
      }))
    });
  }

  /* ---------------- systems (integrations) ----------------------------- */
  if (path === 'control/systems' && method === 'GET') {
    const rows = await all(env, 'SELECT * FROM cx_systems ORDER BY created_at ASC');
    const keyRows = await all(env, 'SELECT id, system_id, label, key_prefix, daily_limit, status, last_used_at, created_at FROM cx_api_keys ORDER BY created_at DESC');
    const usage = await all(env, `SELECT system_id, status, COUNT(*) AS n FROM cx_jobs
      WHERE created_at >= ? GROUP BY system_id, status`, new Date(Date.now() - 30 * 86400000).toISOString());
    const shopCounts = await all(env, 'SELECT system_id, COUNT(*) AS n FROM cx_shops GROUP BY system_id');
    const deviceCounts = await all(env,
      "SELECT sh.system_id, COUNT(*) AS n FROM cx_devices d JOIN cx_shops sh ON sh.id = d.shop_id WHERE d.status != 'revoked' GROUP BY sh.system_id");
    const usageMap = {}, shopMap = {}, devMap = {};
    for (const u of usage) {
      usageMap[u.system_id] ||= { sent: 0, failed: 0, pending: 0, cancelled: 0 };
      if (u.status === 'sent') usageMap[u.system_id].sent += u.n;
      else if (u.status === 'failed') usageMap[u.system_id].failed += u.n;
      else if (u.status === 'cancelled') usageMap[u.system_id].cancelled += u.n;
      else usageMap[u.system_id].pending += u.n;
    }
    for (const s of shopCounts) shopMap[s.system_id] = s.n;
    for (const d of deviceCounts) devMap[d.system_id] = d.n;
    return json(rows.map(s => ({
      id: s.id, system_key: s.system_key, name: s.name, description: s.description,
      api_url: s.api_url, auth_mode: s.auth_mode || 'federated',
      api_key_set: !!s.api_key, api_key_hint: maskSecret(s.api_key),
      login_path: s.login_path, shops_path: s.shops_path,
      webhook_url: s.webhook_url, status: s.status,
      last_pull_at: s.last_pull_at || null, last_pull_error: s.last_pull_error || null,
      configured: !!s.api_url && (s.auth_mode !== 'api_key' || !!s.api_key),
      shops: shopMap[s.id] || 0, devices: devMap[s.id] || 0,
      created_at: s.created_at,
      usage30d: usageMap[s.id] || { sent: 0, failed: 0, pending: 0, cancelled: 0 },
      keys: keyRows.filter(k => k.system_id === s.id)
    })));
  }
  if (path === 'control/systems' && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can add system integrations.', 403);
    const b = await body();
    const name = str(b.name || '', 120);
    const key = str(b.system_key || b.client_key || name.toLowerCase().replace(/[^a-z0-9]+/g, ''), 40).replace(/[^a-z0-9_]/g, '');
    if (!name || !/^[a-z0-9_]{2,40}$/.test(key)) return fail('Name and a slug system_key (a-z, 0-9, _) are required.', 400);
    const dup = await get(env, 'SELECT id FROM cx_systems WHERE system_key = ?', key);
    if (dup) return fail('That system_key already exists.', 409);
    if (b.api_url && !validHttpUrl(b.api_url)) return fail('API URL must be a valid http(s) URL.', 400);
    const authMode = b.auth_mode === 'api_key' ? 'api_key' : 'federated';
    const def = MODE_DEFAULTS[authMode];
    const id = uuid();
    await insert(env, 'cx_systems', {
      id, system_key: key, name, description: str(b.description || '', 500),
      api_url: str(b.api_url || '', 500).replace(/\/+$/, ''),
      auth_mode: authMode, api_key: str(b.api_key || '', 200),
      login_path: str(b.login_path || def.login_path, 200).replace(/^\/+/, ''),
      shops_path: str(b.shops_path || def.shops_path, 200).replace(/^\/+/, ''),
      webhook_url: null, status: 'active',
      last_pull_at: null, last_pull_error: null,
      created_at: nowIso(), updated_at: nowIso()
    });
    await auditOp(env, op, 'add system integration', 'system', id, { name, system_key: key, auth_mode: authMode });
    return json({ ok: true, system: safeSystem(await get(env, 'SELECT * FROM cx_systems WHERE id = ?', id)) }, 201);
  }
  if (path.match(/^control\/systems\/[^/]+$/) && ['PATCH', 'DELETE'].includes(method)) {
    if (!ownerOnly(op)) return fail('Only the owner can manage system integrations.', 403);
    const id = decodeURIComponent(path.split('/')[2]);
    const system = await get(env, 'SELECT * FROM cx_systems WHERE id = ?', id);
    if (!system) return fail('System not found.', 404);
    if (method === 'DELETE') {
      const jobs = await get(env, 'SELECT COUNT(*) AS n FROM cx_jobs WHERE system_id = ?', id);
      if (Number(jobs?.n || 0) > 0)
        return fail('This system has message history. Disable it instead of deleting (history is kept for audit).', 409);
      const devices = await get(env,
        'SELECT COUNT(*) AS n FROM cx_devices d JOIN cx_shops sh ON sh.id = d.shop_id WHERE sh.system_id = ?', id);
      if (Number(devices?.n || 0) > 0)
        return fail('Gateway devices are still paired to shops of this system. Revoke them first.', 409);
      await run(env, 'DELETE FROM cx_api_keys WHERE system_id = ?', id);
      await run(env, 'DELETE FROM cx_shops WHERE system_id = ?', id);
      await run(env, 'DELETE FROM cx_admins WHERE system_id = ?', id);
      await run(env, 'DELETE FROM cx_systems WHERE id = ?', id);
      await auditOp(env, op, 'delete system integration', 'system', id, { name: system.name });
      return json({ ok: true, deleted: true });
    }
    const b = await body();
    const patch = { updated_at: nowIso() };
    if (b.name !== undefined) patch.name = str(b.name, 120) || system.name;
    if (b.description !== undefined) patch.description = str(b.description, 500);
    if (b.status !== undefined && ['active', 'disabled'].includes(b.status)) patch.status = b.status;
    if (b.api_url !== undefined) {
      const au = str(b.api_url, 500).trim().replace(/\/+$/, '');
      if (au && !validHttpUrl(au)) return fail('API URL must be a valid http(s) URL.', 400);
      patch.api_url = au;
    }
    if (b.auth_mode !== undefined && ['federated', 'api_key'].includes(b.auth_mode)) {
      patch.auth_mode = b.auth_mode;
      // Switching modes also swaps the endpoint paths when they are still the
      // other mode's defaults, so the Configure form "just works".
      const from = MODE_DEFAULTS[system.auth_mode === 'api_key' ? 'api_key' : 'federated'];
      const to = MODE_DEFAULTS[b.auth_mode];
      const curLogin = b.login_path !== undefined ? patch.login_path : system.login_path;
      const curShops = b.shops_path !== undefined ? patch.shops_path : system.shops_path;
      if (b.login_path === undefined && curLogin === from.login_path) patch.login_path = to.login_path;
      if (b.shops_path === undefined && curShops === from.shops_path) patch.shops_path = to.shops_path;
      if (b.auth_mode !== (system.auth_mode || 'federated')) patch.last_pull_error = null;
    }
    if (b.api_key !== undefined) patch.api_key = str(b.api_key, 200).replace(/\s+/g, '');
    if (b.login_path !== undefined) patch.login_path = str(b.login_path, 200).replace(/^\/+/, '') || system.login_path;
    if (b.shops_path !== undefined) patch.shops_path = str(b.shops_path, 200).replace(/^\/+/, '') || system.shops_path;
    if (b.webhook_url !== undefined) {
      const wu = str(b.webhook_url, 500);
      if (wu && !/^https:\/\//.test(wu)) return fail('Webhook URL must be https:// or empty.', 400);
      patch.webhook_url = wu || null;
    }
    await update(env, 'cx_systems', patch, 'id = ?', id);
    await auditOp(env, op, 'update system integration', 'system', id, { fields: Object.keys(b) });
    return json({ ok: true, system: safeSystem(await get(env, 'SELECT * FROM cx_systems WHERE id = ?', id)) });
  }

  /* ---------------- API keys (owner) ----------------------------------- */
  if (path.match(/^control\/systems\/[^/]+\/keys$/) && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can issue API keys.', 403);
    const id = decodeURIComponent(path.split('/')[2]);
    const system = await get(env, 'SELECT * FROM cx_systems WHERE id = ?', id);
    if (!system) return fail('System not found.', 404);
    const b = await body();
    const plain = clientApiKey();
    const row = {
      id: uuid(), system_id: system.id,
      label: str(b.label || 'Default key', 120),
      key_prefix: plain.slice(0, 16),
      key_hash: await sha256(plain),
      daily_limit: Math.max(0, Number(b.daily_limit ?? Number(env.DEFAULT_DAILY_LIMIT || 1000))),
      status: 'active', last_used_at: null, created_at: nowIso(), revoked_at: null
    };
    await insert(env, 'cx_api_keys', row);
    await auditOp(env, op, 'issue API key', 'system', system.id, { label: row.label, prefix: row.key_prefix });
    // The plain key is returned exactly once.
    return json({ ok: true, api_key: plain, key: { ...row, key_hash: undefined } }, 201);
  }
  if (path.match(/^control\/keys\/[^/]+\/revoke$/) && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can revoke API keys.', 403);
    const id = decodeURIComponent(path.split('/')[2]);
    const k = await get(env, 'SELECT * FROM cx_api_keys WHERE id = ?', id);
    if (!k) return fail('API key not found.', 404);
    await update(env, 'cx_api_keys', { status: 'revoked', revoked_at: nowIso() }, 'id = ?', id);
    await auditOp(env, op, 'revoke API key', 'system', k.system_id, { prefix: k.key_prefix });
    return json({ ok: true });
  }

  /* ---------------- shops ---------------------------------------------- */
  if (path === 'control/shops' && method === 'GET') {
    const q = url.searchParams;
    const conds = [], binds = [];
    if (q.get('system_id')) { conds.push('sh.system_id = ?'); binds.push(q.get('system_id')); }
    if (q.get('status') && ['active', 'paused'].includes(q.get('status'))) { conds.push('sh.status = ?'); binds.push(q.get('status')); }
    if (q.get('search')) {
      conds.push('(sh.name LIKE ? OR sh.external_id LIKE ? OR sh.shop_code LIKE ?)');
      const s = `%${str(q.get('search'), 80)}%`; binds.push(s, s, s);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await all(env,
      `SELECT sh.*, s.name AS system_name, s.system_key
         FROM cx_shops sh LEFT JOIN cx_systems s ON s.id = sh.system_id
         ${where} ORDER BY sh.name ASC LIMIT 300`, ...binds);
    const deviceCounts = await all(env, "SELECT shop_id, COUNT(*) AS n FROM cx_devices WHERE status != 'revoked' GROUP BY shop_id");
    const dMap = Object.fromEntries(deviceCounts.map(r => [r.shop_id, r.n]));
    const devices = await all(env, "SELECT shop_id, last_seen, status FROM cx_devices WHERE status != 'revoked'");
    const onlineMap = {};
    for (const d of devices) if (onlineOf(d.last_seen)) onlineMap[d.shop_id] = (onlineMap[d.shop_id] || 0) + 1;
    return json(rows.map(sh => ({
      ...publicShop(sh),
      system_id: sh.system_id, system_name: sh.system_name, system_key: sh.system_key,
      devices: dMap[sh.id] || 0, online: onlineMap[sh.id] || 0,
      created_at: sh.created_at, updated_at: sh.updated_at
    })));
  }
  if (path === 'control/shops' && method === 'POST') {
    // Manual provisioning (e.g. so a pairing code can be created before the
    // administrator's first sign-in syncs the shop automatically).
    const b = await body();
    const system = await get(env, 'SELECT * FROM cx_systems WHERE id = ?', str(b.system_id || ''));
    if (!system) return fail('Choose a system for this shop.', 404);
    const externalId = str(b.external_id || b.shop_id || '', 80);
    const name = str(b.name || '', 160);
    if (!externalId || !name) return fail('The shop id inside the system and a name are required.', 400);
    const dup = await get(env, 'SELECT id FROM cx_shops WHERE system_id = ? AND external_id = ?', system.id, externalId);
    if (dup) return fail('That shop is already registered.', 409);
    const id = uuid();
    await insert(env, 'cx_shops', {
      id, system_id: system.id, external_id: externalId, name,
      shop_code: str(b.shop_code || '', 60), address: str(b.address || '', 240),
      phone: str(b.phone || '', 32), category: str(b.category || '', 80),
      system_status: 'active', status: 'active', created_at: nowIso(), updated_at: nowIso()
    });
    await auditOp(env, op, 'register shop', 'shop', id, { name, system: system.system_key, external_id: externalId });
    return json({ ok: true, shop: publicShop(await get(env, 'SELECT * FROM cx_shops WHERE id = ?', id)) }, 201);
  }
  if (path.match(/^control\/shops\/[^/]+$/) && ['PATCH', 'DELETE'].includes(method)) {
    const id = decodeURIComponent(path.split('/')[2]);
    const shop = await get(env, 'SELECT * FROM cx_shops WHERE id = ?', id);
    if (!shop) return fail('Shop not found.', 404);
    if (method === 'DELETE') {
      if (!ownerOnly(op)) return fail('Only the owner can delete a shop.', 403);
      const jobs = await get(env, 'SELECT COUNT(*) AS n FROM cx_jobs WHERE shop_id = ?', id);
      const devices = await get(env, "SELECT COUNT(*) AS n FROM cx_devices WHERE shop_id = ? AND status != 'revoked'", id);
      if (Number(jobs?.n || 0) > 0 || Number(devices?.n || 0) > 0)
        return fail('This shop has devices or message history. Pause it instead of deleting.', 409);
      await run(env, 'DELETE FROM cx_shops WHERE id = ?', id);
      await auditOp(env, op, 'delete shop', 'shop', id, { name: shop.name });
      return json({ ok: true, deleted: true });
    }
    const b = await body();
    const patch = { updated_at: nowIso() };
    if (b.name !== undefined) patch.name = str(b.name, 160) || shop.name;
    if (b.shop_code !== undefined) patch.shop_code = str(b.shop_code, 60);
    if (b.status !== undefined && ['active', 'paused'].includes(b.status)) patch.status = b.status;
    await update(env, 'cx_shops', patch, 'id = ?', id);
    await auditOp(env, op, 'update shop', 'shop', id, { fields: Object.keys(b) });
    return json({ ok: true, shop: publicShop(await get(env, 'SELECT * FROM cx_shops WHERE id = ?', id)) });
  }

  /* ---------------- devices ------------------------------------------- */
  if (path === 'control/devices' && method === 'GET') {
    const shopFilter = url.searchParams.get('shop_id');
    const rows = await all(env,
      `SELECT d.*, sh.name AS shop_name, sh.external_id AS shop_external_id, s.name AS system_name, s.system_key
         FROM cx_devices d LEFT JOIN cx_shops sh ON sh.id = d.shop_id
         LEFT JOIN cx_systems s ON s.id = sh.system_id
        ${shopFilter ? 'WHERE d.shop_id = ?' : ''}
        ORDER BY d.last_seen DESC, d.created_at DESC LIMIT 200`, ...(shopFilter ? [shopFilter] : []));
    return json(rows.map(d => ({
      ...publicDevice(d),
      shop_name: d.shop_name, shop_external_id: d.shop_external_id,
      system_name: d.system_name, system_key: d.system_key,
      online: onlineOf(d.last_seen) && d.status !== 'revoked'
    })));
  }
  if (path === 'control/devices/pairing-code' && method === 'POST') {
    const b = await body();
    const shopId = str(b.shop_id || '', 64);
    const shop = await get(env, "SELECT * FROM cx_shops WHERE id = ? AND status = 'active'", shopId);
    if (!shop) return fail('Choose an active shop for this pairing code.', 404);
    const system = await get(env, "SELECT * FROM cx_systems WHERE id = ? AND status = 'active'", shop.system_id);
    if (!system) return fail('The system for this shop is not active.', 404);
    const ttl = Math.min(1440, Math.max(5, Number(b.ttl_minutes || 60)));
    const code = pairingCode();
    const id = uuid();
    await insert(env, 'cx_pairing_codes', {
      id, code, shop_id: shop.id, created_by: op.id, device_id: null,
      expires_at: new Date(Date.now() + ttl * 60000).toISOString(), used_at: null, created_at: nowIso()
    });
    await auditOp(env, op, 'create pairing code', 'shop', shop.id, { ttl_minutes: ttl });
    return json({ ok: true, code, shop: publicShop(shop), system: publicSystem(system), expires_in_minutes: ttl }, 201);
  }
  if (path.match(/^control\/devices\/[^/]+\/(revoke|restore|primary|rename)$/) && method === 'POST') {
    const [, , id, action] = path.split('/');
    const device = await get(env, 'SELECT * FROM cx_devices WHERE id = ?', decodeURIComponent(id));
    if (!device) return fail('Device not found.', 404);
    if (action === 'revoke') {
      await update(env, 'cx_devices', { status: 'revoked', is_primary: 0, token_hash: null, updated_at: nowIso() }, 'id = ?', device.id);
      await auditOp(env, op, 'revoke gateway device', 'device', device.id, { device_name: device.device_name });
      return json({ ok: true });
    }
    if (device.status === 'revoked') return fail('Device is revoked. The phone must pair again.', 409);
    if (action === 'restore') {
      await update(env, 'cx_devices', { status: 'pending_test', updated_at: nowIso() }, 'id = ?', device.id);
      await auditOp(env, op, 'restore gateway device', 'device', device.id);
      return json({ ok: true, note: 'The phone must re-run its connection test to become active.' });
    }
    if (action === 'primary') {
      await update(env, 'cx_devices', { is_primary: 0 }, 'shop_id = ?', device.shop_id);
      await update(env, 'cx_devices', { is_primary: 1, updated_at: nowIso() }, 'id = ?', device.id);
      await auditOp(env, op, 'set primary gateway', 'device', device.id);
      return json({ ok: true });
    }
    const b = await body();
    await update(env, 'cx_devices', { device_name: str(b.device_name || '', 120) || device.device_name, updated_at: nowIso() }, 'id = ?', device.id);
    return json({ ok: true });
  }

  /* ---------------- jobs ---------------------------------------------- */
  if (path === 'control/jobs' && method === 'GET') {
    const q = url.searchParams;
    const conds = [], binds = [];
    if (q.get('channel') && ['sms', 'email'].includes(q.get('channel'))) { conds.push('j.channel = ?'); binds.push(q.get('channel')); }
    if (q.get('status') && ['queued', 'sending', 'sent', 'failed', 'cancelled'].includes(q.get('status'))) { conds.push('j.status = ?'); binds.push(q.get('status')); }
    if (q.get('shop_id')) { conds.push('j.shop_id = ?'); binds.push(q.get('shop_id')); }
    if (q.get('system_id')) { conds.push('j.system_id = ?'); binds.push(q.get('system_id')); }
    if (q.get('search')) { conds.push('(j.to_phone LIKE ? OR j.recipient_name LIKE ? OR j.message_body LIKE ? OR j.subject LIKE ?)'); const s = `%${str(q.get('search'), 80)}%`; binds.push(s, s, s, s); }
    if (q.get('since')) { conds.push('j.created_at >= ?'); binds.push(q.get('since')); }
    const limit = Math.min(200, Math.max(1, Number(q.get('limit') || 50)));
    const offset = Math.max(0, Number(q.get('offset') || 0));
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await all(env,
      `SELECT j.*, s.name AS system_name, s.system_key, sh.name AS shop_name, sh.external_id AS shop_external_id, d.device_name
         FROM cx_jobs j
         LEFT JOIN cx_systems s ON s.id = j.system_id
         LEFT JOIN cx_shops sh ON sh.id = j.shop_id
         LEFT JOIN cx_devices d ON d.id = j.device_id
         ${where} ORDER BY j.created_at DESC LIMIT ? OFFSET ?`, ...binds, limit + 1, offset);
    const hasMore = rows.length > limit;
    return json({
      items: rows.slice(0, limit).map(jobView),
      hasMore, limit, offset
    });
  }
  if (path === 'control/jobs' && method === 'POST') {
    // Manual send from the console.
    const b = await body();
    const shop = await get(env, "SELECT * FROM cx_shops WHERE id = ? AND status = 'active'", str(b.shop_id || ''));
    if (!shop) return fail('Choose an active shop.', 404);
    const phone = cleanPhone(b.to || b.phone);
    const messageBody = str(b.message || '', 1600);
    if (!phone) return fail('A valid destination phone number is required.', 400);
    if (!messageBody) return fail('Message text is required.', 400);
    const row = smsJobRow({
      shopId: shop.id, systemId: null, apiKeyId: null,
      phone, name: b.recipient_name, recipientType: 'manual',
      messageType: b.message_type || 'Console Message', eventType: b.event_type || 'CONSOLE',
      referenceId: b.reference_id, referenceNumber: b.reference_number,
      messageBody, idempotencyKey: `CONSOLE:${uuid()}`
    });
    await insert(env, 'cx_jobs', row);
    await auditOp(env, op, 'queue manual SMS', 'job', row.id, { to: phone, shop: shop.name });
    return json({ ok: true, job: jobView(row) }, 201);
  }
  if (path.match(/^control\/jobs\/[^/]+\/(cancel|retry)$/) && method === 'POST') {
    const [, , id, action] = path.split('/');
    const job = await get(env, 'SELECT * FROM cx_jobs WHERE id = ?', decodeURIComponent(id));
    if (!job) return fail('Job not found.', 404);
    if (action === 'cancel') {
      if (job.status !== 'queued') return fail('Only queued jobs can be cancelled.', 409);
      const changes = await update(env, 'cx_jobs',
        { status: 'cancelled', error_message: 'Cancelled from ConnectX Control' },
        "id = ? AND status = 'queued'", job.id);
      if (!changes) return fail('Job was already claimed by a gateway.', 409);
      await auditOp(env, op, 'cancel job', 'job', job.id, { to: job.to_phone || job.subject });
      if (job.external_job_id) ctx.waitUntil?.(reportJobToSystem(env, job, 'failed', 'Cancelled in ConnectX Control'));
      return json({ ok: true, cancelled: true });
    }
    // retry: re-queue failed/cancelled SMS below max attempts
    if (job.channel !== 'sms') return fail('Only SMS jobs can be retried on a gateway.', 400);
    if (!['failed', 'cancelled'].includes(job.status)) return fail('Only failed or cancelled jobs can be retried.', 409);
    if (Number(job.attempts || 0) >= Number(job.max_attempts || 3))
      await update(env, 'cx_jobs', { max_attempts: Number(job.max_attempts || 3) + 2 }, 'id = ?', job.id);
    await update(env, 'cx_jobs',
      { status: 'queued', error_message: null, claimed_at: null, device_id: null },
      'id = ?', job.id);
    await auditOp(env, op, 'retry job', 'job', job.id);
    return json({ ok: true, retried: true });
  }

  /* ---------------- releases (ConnectX app store) --------------------- */
  if (path === 'control/releases' && method === 'GET') {
    const rows = await all(env, 'SELECT * FROM cx_releases ORDER BY updated_at DESC LIMIT 100');
    const out = [];
    for (const r of rows) out.push({ ...r, mandatory: bool(r.mandatory), published: bool(r.published), download_available: (await releaseStatus(env, r)).available, download_url: downloadPath(r) });
    return json(out);
  }
  if (path === 'control/releases' && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can publish releases.', 403);
    const b = await body();
    const pkg = str(b.package_name || 'com.connectx.gateway', 120);
    const title = str(b.title || 'ConnectX: Central Communication Gateway powered by Dexter Studio', 200);
    const version = str(b.version || '', 30);
    const code = Number(b.version_code || 0);
    if (!isPackage(pkg)) return fail('Invalid Android package name.', 400);
    if (!isVersion(version) || !Number.isSafeInteger(code) || code <= 0) return fail('Version (e.g. 2.0.0) and a positive integer version_code are required.', 400);
    const old = await get(env, 'SELECT * FROM cx_releases WHERE package_name = ? ORDER BY version_code DESC LIMIT 1', pkg);
    if (old && code < Number(old.version_code)) return fail('version_code cannot be lower than the current release.', 409);
    const record = {
      package_name: pkg, title, description: str(b.description || '', 2000),
      version, version_code: code,
      mandatory: b.mandatory ? 1 : 0,
      release_notes: str(b.release_notes || '', 5000),
      apk_filename: str(b.apk_filename || `${pkg}-${version}.apk`, 180),
      apk_size_bytes: Math.max(0, Number(b.apk_size_bytes || 0)),
      apk_r2_key: str(b.apk_r2_key || '', 500) || null,
      apk_url: str(b.apk_url || '', 500),
      published: b.published ? 1 : 0,
      updated_at: nowIso()
    };
    if (!record.apk_filename.toLowerCase().endsWith('.apk') || record.apk_filename.includes('..'))
      return fail('APK filename must end with .apk.', 400);
    if (record.apk_r2_key && !apkKey({ ...record, package_name: pkg }))
      return fail('APK storage key must belong to releases/<package>/.', 400);
    if (record.published) {
      const status = await releaseStatus(env, { ...record, package_name: pkg });
      if (!status.available) return fail('Cannot publish without a downloadable APK. Upload one first (or set a working https apk_url).', 422);
    }
    let saved;
    if (old) {
      await update(env, 'cx_releases', { ...record, id: undefined }, 'id = ?', old.id);
      saved = await get(env, 'SELECT * FROM cx_releases WHERE id = ?', old.id);
    } else {
      const id = uuid();
      await insert(env, 'cx_releases', { id, ...record, created_at: nowIso() });
      saved = await get(env, 'SELECT * FROM cx_releases WHERE id = ?', id);
    }
    await auditOp(env, op, old ? 'update release' : 'create release', 'release', saved.id, { package_name: pkg, version, version_code: code, published: record.published });
    return json({ ok: true, release: { ...saved, download_available: (await releaseStatus(env, saved)).available } }, old ? 200 : 201);
  }
  if (path === 'control/releases/upload' && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can upload APKs.', 403);
    const bucket = getReleaseBucket(env);
    if (!bucket) return fail('Release storage is not configured. Bind APP_STORAGE to an R2 bucket (see DEPLOY.md).', 503);
    const form = await request.formData();
    const file = form.get('file');
    const pkg = str(form.get('package_name') || 'com.connectx.gateway', 120);
    if (!isPackage(pkg)) return fail('Invalid package name.', 400);
    if (!file || typeof file === 'string' || !file.name || !file.size) return fail('Choose a non-empty APK file.', 400);
    if (file.size > 150 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.apk')) return fail('Use an APK file under 150 MB.', 400);
    const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (magic[0] !== 0x50 || magic[1] !== 0x4b) return fail('The APK must be a valid ZIP-format Android package.', 400);
    const key = `releases/${pkg}/apk/${Date.now()}-${uuid()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    try {
      await bucket.put(key, file.stream(), { httpMetadata: { contentType: 'application/vnd.android.package-archive' } });
      const saved = await bucket.head(key);
      if (!saved || Number(saved.size) !== file.size) throw new Error('upload verification failed');
    } catch (e) {
      console.error('release upload failed', e);
      try { await bucket.delete(key); } catch {}
      return fail('APK upload failed. Check the R2 binding and retry.', 503);
    }
    await auditOp(env, op, 'upload APK', 'release', pkg, { key, size: file.size });
    return json({ ok: true, apk_r2_key: key, filename: file.name, size_bytes: file.size });
  }
  if (path.match(/^control\/releases\/[^/]+$/) && ['PATCH', 'DELETE'].includes(method)) {
    if (!ownerOnly(op)) return fail('Only the owner can manage releases.', 403);
    const id = decodeURIComponent(path.split('/')[2]);
    const rel = await get(env, 'SELECT * FROM cx_releases WHERE id = ?', id);
    if (!rel) return fail('Release not found.', 404);
    if (method === 'DELETE') {
      await run(env, 'DELETE FROM cx_releases WHERE id = ?', id);
      await auditOp(env, op, 'delete release', 'release', id, { package_name: rel.package_name, version: rel.version });
      return json({ ok: true, deleted: true });
    }
    const b = await body();
    const patch = { updated_at: nowIso() };
    if (b.title !== undefined) patch.title = str(b.title, 200) || rel.title;
    if (b.description !== undefined) patch.description = str(b.description, 2000);
    if (b.version !== undefined && isVersion(str(b.version))) patch.version = str(b.version, 30);
    if (b.version_code !== undefined) {
      const vc = Number(b.version_code);
      if (!Number.isSafeInteger(vc) || vc <= 0) return fail('version_code must be a positive integer.', 400);
      patch.version_code = vc;
    }
    if (b.mandatory !== undefined) patch.mandatory = b.mandatory ? 1 : 0;
    if (b.published !== undefined) patch.published = b.published ? 1 : 0;
    if (b.release_notes !== undefined) patch.release_notes = str(b.release_notes, 5000);
    if (b.apk_url !== undefined) patch.apk_url = str(b.apk_url, 500);
    if (patch.published === 1 || (patch.published === undefined && bool(rel.published))) {
      const status = await releaseStatus(env, { ...rel, ...patch });
      if (!status.available) return fail('Cannot keep published without a downloadable APK.', 422);
    }
    await update(env, 'cx_releases', patch, 'id = ?', id);
    await auditOp(env, op, 'update release', 'release', id, { fields: Object.keys(b) });
    const saved = await get(env, 'SELECT * FROM cx_releases WHERE id = ?', id);
    return json({ ok: true, release: { ...saved, download_available: (await releaseStatus(env, saved)).available } });
  }

  /* ---------------- SIM carrier catalog ------------------------------- */
  if (path === 'control/carriers' && method === 'GET')
    return json(await all(env, 'SELECT * FROM cx_sim_carriers ORDER BY carrier_name ASC'));
  if (path === 'control/carriers' && method === 'POST') {
    const b = await body();
    const name = str(b.carrier_name || '', 120);
    if (!name) return fail('Carrier name is required.', 400);
    const mcc = str(b.mcc_mnc || '').replace(/\D/g, '');
    if (mcc && !/^\d{5,6}$/.test(mcc)) return fail('MCC/MNC must be 5-6 digits.', 400);
    const ussd = str(b.balance_ussd_code || '', 32);
    if (ussd && !/^\*[\d*#]+#$/.test(ussd)) return fail('USSD code must look like *123#.', 400);
    const id = uuid();
    await insert(env, 'cx_sim_carriers', {
      id, carrier_name: name, carrier_identifier: str(b.carrier_identifier || '', 120) || null,
      mcc_mnc: mcc || null, balance_ussd_code: ussd || null,
      balance_pattern: str(b.balance_pattern || '', 200) || null,
      active: b.active === undefined ? 1 : (b.active ? 1 : 0),
      created_at: nowIso(), updated_at: nowIso()
    });
    await auditOp(env, op, 'add SIM carrier', 'carrier', id, { carrier_name: name });
    return json({ ok: true, carrier: await get(env, 'SELECT * FROM cx_sim_carriers WHERE id = ?', id) }, 201);
  }
  if (path.match(/^control\/carriers\/[^/]+$/) && ['PATCH', 'DELETE'].includes(method)) {
    const id = decodeURIComponent(path.split('/')[2]);
    const c = await get(env, 'SELECT * FROM cx_sim_carriers WHERE id = ?', id);
    if (!c) return fail('Carrier not found.', 404);
    if (method === 'DELETE') {
      await run(env, 'DELETE FROM cx_sim_carriers WHERE id = ?', id);
      await auditOp(env, op, 'delete SIM carrier', 'carrier', id, { carrier_name: c.carrier_name });
      return json({ ok: true, deleted: true });
    }
    const b = await body();
    const patch = { updated_at: nowIso() };
    for (const k of ['carrier_name', 'carrier_identifier', 'mcc_mnc', 'balance_ussd_code', 'balance_pattern'])
      if (b[k] !== undefined) patch[k] = str(b[k], 200) || null;
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    await update(env, 'cx_sim_carriers', patch, 'id = ?', id);
    return json({ ok: true, carrier: await get(env, 'SELECT * FROM cx_sim_carriers WHERE id = ?', id) });
  }

  /* ---------------- settings ------------------------------------------ */
  if (path === 'control/settings' && method === 'GET') {
    const rows = await all(env, 'SELECT * FROM cx_settings');
    const out = {};
    // The email provider config (incl. its API key) is owner-only and served
    // masked by GET control/email — never leak it through generic settings.
    for (const r of rows) if (r.setting_key !== 'email') out[r.setting_key] = parseJson(r.setting_value, null);
    out.sms ||= {};
    return json({ ...out, defaultTemplates: DEFAULT_TEMPLATES });
  }
  if (path === 'control/settings' && method === 'PATCH') {
    const b = await body();
    for (const key of Object.keys(b)) {
      if (key !== 'sms') continue;
      const existing = await get(env, 'SELECT * FROM cx_settings WHERE setting_key = ?', key);
      const merged = { ...(parseJson(existing?.setting_value, {}) || {}), ...b[key] };
      if (existing) await update(env, 'cx_settings', { setting_value: JSON.stringify(merged), updated_at: nowIso() }, 'setting_key = ?', key);
      else await insert(env, 'cx_settings', { setting_key: key, setting_value: JSON.stringify(merged), updated_at: nowIso() });
    }
    await auditOp(env, op, 'update settings', 'settings', null, { keys: Object.keys(b).filter(k => k === 'sms') });
    return json({ ok: true });
  }

  /* ---------------- email gateway (owner only) -------------------------- */
  if (path === 'control/email' && method === 'GET') {
    if (!ownerOnly(op)) return fail('Only the owner can manage email sending.', 403);
    const cfg = await emailConfig(env);
    return json({
      provider: cfg.provider,
      providers: providerList(env),
      from_name: cfg.fromName,
      from_email: cfg.fromEmail,
      reply_to: cfg.replyTo,
      enabled: cfg.enabled,
      daily_limit: cfg.dailyLimit,
      mailgun_domain: cfg.mailgunDomain,
      api_key_set: !!cfg.apiKey,
      key_source: cfg.keySource           // 'environment' | 'database' | null
    });
  }
  if (path === 'control/email' && method === 'PATCH') {
    if (!ownerOnly(op)) return fail('Only the owner can manage email sending.', 403);
    const b = await body();
    const existing = await get(env, "SELECT * FROM cx_settings WHERE setting_key = 'email'");
    const current = parseJson(existing?.setting_value, {}) || {};
    const next = { ...current };
    if (b.provider !== undefined) {
      const p = str(b.provider, 20).toLowerCase();
      if (!['brevo', 'resend', 'sendgrid', 'mailgun', 'postmark'].includes(p))
        return fail('Unknown provider. Use brevo, resend, sendgrid, mailgun or postmark.', 400);
      next.provider = p;
    }
    // An empty/blank api_key keeps the stored one; any other value replaces it.
    if (b.api_key !== undefined && String(b.api_key).trim()) next.api_key = String(b.api_key).trim().slice(0, 300);
    if (b.from_name !== undefined) next.from_name = str(b.from_name, 160);
    if (b.from_email !== undefined) {
      const fe = str(b.from_email, 320).trim();
      if (fe && !isEmail(fe)) return fail('From Email must be a valid email address.', 400);
      next.from_email = fe;
    }
    if (b.reply_to !== undefined) {
      const rt = str(b.reply_to, 320).trim();
      if (rt && !isEmail(rt)) return fail('Reply-To must be a valid email address.', 400);
      next.reply_to = rt;
    }
    if (b.enabled !== undefined) next.enabled = !!b.enabled;
    if (b.daily_limit !== undefined) next.daily_limit = Math.max(0, Math.min(100000, Number(b.daily_limit) || 0));
    if (b.mailgun_domain !== undefined) next.mailgun_domain = str(b.mailgun_domain, 200).trim();
    if (existing) await update(env, 'cx_settings', { setting_value: JSON.stringify(next), updated_at: nowIso() }, "setting_key = 'email'");
    else await insert(env, 'cx_settings', { setting_key: 'email', setting_value: JSON.stringify(next), updated_at: nowIso() });
    await auditOp(env, op, 'update email settings', 'settings', null,
      { provider: next.provider, from_email: next.from_email, enabled: next.enabled, api_key_changed: !!(b.api_key && String(b.api_key).trim()) });
    const cfg = await emailConfig(env);
    return json({ ok: true, api_key_set: !!cfg.apiKey, key_source: cfg.keySource });
  }
  if (path === 'control/email/test' && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can manage email sending.', 403);
    const b = await body();
    const to = str(b.to || '', 320).trim();
    if (!to || !isEmail(to)) return fail('Enter one valid test recipient email.', 400);
    const cfg = await emailConfig(env);
    if (!cfg.fromEmail) return fail('Save a valid From Email first.', 400);
    if (!cfg.apiKey) return fail('No provider API key is set. Paste one here or set the ' +
      (providerList(env).find(p => p.id === cfg.provider)?.envKey || 'provider') + ' environment secret.', 503);
    const result = await sendEmail(env, cfg, {
      to: [to], cc: [], bcc: [],
      subject: 'ConnectX Provider Test',
      html: '<div style="font-family:Arial,sans-serif;color:#172033;line-height:1.6"><h2 style="margin:0 0 8px">✓ ConnectX email works</h2><p style="color:#555">Your ' + cfg.provider + ' provider accepted this test email. Connected apps can now send email through <span style="font-family:monospace">POST /api/client/v1/email/send</span>.</p></div>',
      fromName: cfg.fromName || 'ConnectX'
    });
    if (!result.ok) return fail(result.error, 502);
    await auditOp(env, op, 'send email provider test', 'settings', null, { to, provider: cfg.provider });
    return json({ ok: true, messageId: result.messageId || null, mocked: !!result.mocked });
  }

  /* ---------------- operators (owner only) ---------------------------- */
  if (path === 'control/operators' && method === 'GET') {
    if (!ownerOnly(op)) return fail('Only the owner can list accounts.', 403);
    const rows = await all(env, 'SELECT id, name, email, phone, address, operator_code, role, active, last_login_at, created_at FROM cx_operators ORDER BY created_at ASC');
    return json(rows.map(r => ({ ...r, active: bool(r.active) })));
  }
  if (path === 'control/operators' && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can add accounts.', 403);
    const b = await body();
    const name = str(b.name || '', 120);
    const email = str(b.email || '').toLowerCase();
    const password = String(b.password || '');
    if (!name || !isEmail(email)) return fail('Name and a valid email are required.', 400);
    if (password.length < 10) return fail('Password must be at least 10 characters.', 400);
    const dup = await get(env, 'SELECT id FROM cx_operators WHERE email = ?', email);
    if (dup) return fail('That email is already registered.', 409);
    const id = uuid();
    await insert(env, 'cx_operators', {
      id, name, email, phone: str(b.phone || '', 32), address: str(b.address || '', 240),
      operator_code: 'CX-' + id.replaceAll('-', '').slice(0, 6).toUpperCase(),
      password_hash: await hashPassword(password),
      role: b.role === 'owner' ? 'owner' : 'operator', active: 1,
      created_at: nowIso(), updated_at: nowIso()
    });
    await auditOp(env, op, 'create operator account', 'operator', id, { email });
    return json({ ok: true, operator: publicOperator(await get(env, 'SELECT * FROM cx_operators WHERE id = ?', id)) }, 201);
  }
  if (path.match(/^control\/operators\/[^/]+$/) && method === 'PATCH') {
    if (!ownerOnly(op)) return fail('Only the owner can manage accounts.', 403);
    const id = decodeURIComponent(path.split('/')[2]);
    if (!isUuid(id)) return fail('Invalid operator id.', 400);
    const target = await get(env, 'SELECT * FROM cx_operators WHERE id = ?', id);
    if (!target) return fail('Account not found.', 404);
    const b = await body();
    const patch = { updated_at: nowIso() };
    if (b.name !== undefined) patch.name = str(b.name, 120) || target.name;
    if (b.phone !== undefined) patch.phone = str(b.phone, 32);
    if (b.address !== undefined) patch.address = str(b.address, 240);
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.role !== undefined && ['owner', 'operator'].includes(b.role)) patch.role = b.role;
    if (b.password) {
      if (String(b.password).length < 10) return fail('Password must be at least 10 characters.', 400);
      patch.password_hash = await hashPassword(String(b.password));
    }
    if (target.id === op.id && patch.active === 0) return fail('You cannot deactivate your own account.', 400);
    await update(env, 'cx_operators', patch, 'id = ?', id);
    await auditOp(env, op, 'update operator account', 'operator', id, { fields: Object.keys(b) });
    return json({ ok: true, operator: publicOperator(await get(env, 'SELECT * FROM cx_operators WHERE id = ?', id)) });
  }

  /* ---------------- activity ------------------------------------------ */
  if (path === 'control/activity' && method === 'GET')
    return json({ items: await recentActivity(env, url.searchParams.get('limit')) });

  return fail('Unknown ConnectX control endpoint.', 404);
}

function jobView(j) {
  return {
    id: j.id, channel: j.channel || 'sms', status: j.status,
    shop_id: j.shop_id, shop_name: j.shop_name || null, shop_external_id: j.shop_external_id || null,
    system_id: j.system_id || null, system_name: j.system_name || null, system_key: j.system_key || null,
    to_phone: j.to_phone || null,
    to: j.channel === 'email' ? (parseJson(j.to_emails, []) || []).join(', ') : (j.to_phone || null),
    to_emails: j.channel === 'email' ? parseJson(j.to_emails, []) : null,
    subject: j.subject || null,
    recipient_name: j.recipient_name || null,
    message_type: j.message_type || null, event_type: j.event_type || null,
    reference_id: j.reference_id || null, reference_number: j.reference_number || null,
    message_body: j.message_body || null,
    device_id: j.device_id || null, device_name: j.device_name || null,
    attempts: Number(j.attempts || 0), max_attempts: Number(j.max_attempts || 3),
    error_message: j.error_message || null,
    created_at: j.created_at, sent_at: j.sent_at || null, claimed_at: j.claimed_at || null
  };
}
