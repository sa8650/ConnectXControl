/* =====================================================================
   ConnectX Control API — backend for the control website.
   Operator/owner sessions (HMAC bearer tokens) manage workspaces,
   gateway devices, message jobs, client products + API keys, releases,
   SIM carrier catalog, platform settings and the audit trail.
   ===================================================================== */
import { all, get, insert, update, run, parseJson } from './db.js';
import {
  json, fail, uuid, nowIso, str, bool, cleanPhone, isEmail, isUuid, isVersion, isPackage,
  dayStart, onlineOf, signToken, verifyToken, bearerOf, hashPassword, checkPassword,
  sha256, clientApiKey, pairingCode, workspaceCode, DEFAULT_TEMPLATES
} from './core.js';
import { logActivity, recentActivity } from './audit.js';
import { publicOperator, publicWorkspace, publicDevice, smsJobRow } from './device.js';
import { apkKey, getReleaseBucket, releaseStatus, downloadPath } from './releases.js';

const CONTROL_TTL = 60 * 60 * 12; // 12h control-panel sessions
const SEED_CLIENTS = [
  { key: 'ems', name: 'EMS', description: 'Enterprise Management Software (legacy owner product).' },
  { key: 'careos', name: 'CareOS', description: 'CareOS platform integration.' },
  { key: 'influenceos', name: 'InfluenceOS', description: 'InfluenceOS platform integration.' },
  { key: 'plugx', name: 'PlugX', description: 'PlugX platform integration.' }
];

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
    // Seed the known product clients once.
    for (const c of SEED_CLIENTS) {
      const dup = await get(env, 'SELECT id FROM cx_clients WHERE client_key = ?', c.key);
      if (!dup) await insert(env, 'cx_clients', {
        id: uuid(), client_key: c.key, name: c.name, description: c.description,
        webhook_url: null, status: 'active', created_at: nowIso(), updated_at: nowIso()
      });
    }
    // Seed a default workspace so a phone can pair immediately.
    const wsCount = await get(env, 'SELECT COUNT(*) AS n FROM cx_workspaces');
    if (!Number(wsCount?.n || 0)) {
      await insert(env, 'cx_workspaces', {
        id: uuid(), name: 'Main Workspace', code: 'MAIN', address: '', phone: '',
        status: 'active', created_at: nowIso(), updated_at: nowIso()
      });
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
    const [jobs, devices, clients, workspaces, recent, byClientRows] = await Promise.all([
      all(env, "SELECT id, channel, status, client_id, workspace_id, created_at FROM cx_jobs WHERE created_at >= ?", today),
      all(env, "SELECT id, status, last_seen, workspace_id FROM cx_devices WHERE status != 'revoked'"),
      all(env, "SELECT id, name, client_key, status FROM cx_clients"),
      all(env, 'SELECT id, name, status FROM cx_workspaces'),
      all(env, `SELECT j.*, c.name AS client_name, w.name AS workspace_name, w.code AS workspace_code
                  FROM cx_jobs j LEFT JOIN cx_clients c ON c.id = j.client_id
                  LEFT JOIN cx_workspaces w ON w.id = j.workspace_id
                 ORDER BY j.created_at DESC LIMIT 12`),
      all(env, "SELECT client_id, status, COUNT(*) AS n FROM cx_jobs WHERE created_at >= ? GROUP BY client_id, status", today)
    ]);
    const count = (ch, sts) => jobs.filter(j => j.channel === ch && sts.includes(j.status)).length;
    const clientMap = Object.fromEntries(clients.map(c => [c.id, c]));
    const byClient = {};
    for (const r of byClientRows) {
      const c = clientMap[r.client_id] || { name: 'Console / Device', client_key: null };
      const keyName = c.name || 'Unknown';
      byClient[keyName] ||= { sent: 0, failed: 0, pending: 0 };
      if (r.status === 'sent') byClient[keyName].sent += r.n;
      else if (r.status === 'failed') byClient[keyName].failed += r.n;
      else if (['queued', 'sending'].includes(r.status)) byClient[keyName].pending += r.n;
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
      workspaces: { total: workspaces.length, active: workspaces.filter(w => w.status === 'active').length },
      clients: { total: clients.length, active: clients.filter(c => c.status === 'active').length },
      byClient,
      recentJobs: recent.map(j => ({
        id: j.id, channel: j.channel, status: j.status,
        to: j.channel === 'sms' ? j.to_phone : (parseJson(j.to_emails, []) || []).join(', '),
        recipient_name: j.recipient_name, message_type: j.message_type,
        client_name: j.client_name || 'Console', workspace_name: j.workspace_name, workspace_code: j.workspace_code,
        created_at: j.created_at, sent_at: j.sent_at
      }))
    });
  }

  /* ---------------- workspaces ---------------------------------------- */
  if (path === 'control/workspaces' && method === 'GET') {
    const rows = await all(env, 'SELECT * FROM cx_workspaces ORDER BY created_at DESC');
    const deviceCounts = await all(env, "SELECT workspace_id, COUNT(*) AS n FROM cx_devices WHERE status != 'revoked' GROUP BY workspace_id");
    const dMap = Object.fromEntries(deviceCounts.map(r => [r.workspace_id, r.n]));
    const devices = await all(env, "SELECT workspace_id, last_seen, status FROM cx_devices WHERE status != 'revoked'");
    const onlineMap = {};
    for (const d of devices) if (onlineOf(d.last_seen)) onlineMap[d.workspace_id] = (onlineMap[d.workspace_id] || 0) + 1;
    return json(rows.map(w => ({
      ...publicWorkspace(w), status: w.status, created_at: w.created_at, updated_at: w.updated_at,
      devices: dMap[w.id] || 0, online: onlineMap[w.id] || 0
    })));
  }
  if (path === 'control/workspaces' && method === 'POST') {
    const b = await body();
    const name = str(b.name || '', 160);
    if (!name) return fail('Workspace name is required.', 400);
    const existing = (await all(env, 'SELECT code FROM cx_workspaces')).map(w => w.code);
    const code = str(b.code || '', 24).toUpperCase().replace(/[^A-Z0-9-]/g, '') || workspaceCode(name, existing);
    if (existing.includes(code)) return fail(`Workspace code "${code}" already exists.`, 409);
    const id = uuid();
    await insert(env, 'cx_workspaces', {
      id, name, code, address: str(b.address || '', 240), phone: str(b.phone || '', 32),
      status: 'active', created_at: nowIso(), updated_at: nowIso()
    });
    await auditOp(env, op, 'create workspace', 'workspace', id, { name, code });
    return json({ ok: true, workspace: publicWorkspace(await get(env, 'SELECT * FROM cx_workspaces WHERE id = ?', id)) }, 201);
  }
  if (path.match(/^control\/workspaces\/[^/]+$/) && ['PATCH', 'DELETE'].includes(method)) {
    const id = decodeURIComponent(path.split('/')[2]);
    const ws = await get(env, 'SELECT * FROM cx_workspaces WHERE id = ?', id);
    if (!ws) return fail('Workspace not found.', 404);
    if (method === 'DELETE') {
      if (!ownerOnly(op)) return fail('Only the owner can delete a workspace.', 403);
      const jobs = await get(env, 'SELECT COUNT(*) AS n FROM cx_jobs WHERE workspace_id = ?', id);
      if (Number(jobs?.n || 0) > 0) return fail('Delete or keep for audit: workspace has message history. Pause it instead.', 409);
      await update(env, 'cx_devices', { status: 'revoked', token_hash: null }, 'workspace_id = ?', id);
      await update(env, 'cx_workspaces', { status: 'paused', updated_at: nowIso() }, 'id = ?', id);
      await auditOp(env, op, 'pause + purge workspace', 'workspace', id, { name: ws.name });
      return json({ ok: true, paused: true });
    }
    const b = await body();
    const patch = { updated_at: nowIso() };
    if (b.name !== undefined) patch.name = str(b.name, 160) || ws.name;
    if (b.address !== undefined) patch.address = str(b.address, 240);
    if (b.phone !== undefined) patch.phone = str(b.phone, 32);
    if (b.status !== undefined && ['active', 'paused'].includes(b.status)) patch.status = b.status;
    await update(env, 'cx_workspaces', patch, 'id = ?', id);
    await auditOp(env, op, 'update workspace', 'workspace', id, { fields: Object.keys(b) });
    return json({ ok: true, workspace: publicWorkspace(await get(env, 'SELECT * FROM cx_workspaces WHERE id = ?', id)) });
  }

  /* ---------------- devices ------------------------------------------- */
  if (path === 'control/devices' && method === 'GET') {
    const wsFilter = url.searchParams.get('workspace_id');
    const rows = await all(env,
      `SELECT d.*, w.name AS workspace_name, w.code AS workspace_code
         FROM cx_devices d LEFT JOIN cx_workspaces w ON w.id = d.workspace_id
        ${wsFilter ? 'WHERE d.workspace_id = ?' : ''}
        ORDER BY d.last_seen DESC, d.created_at DESC LIMIT 200`, ...(wsFilter ? [wsFilter] : []));
    return json(rows.map(d => ({
      ...publicDevice(d),
      workspace_name: d.workspace_name, workspace_code: d.workspace_code,
      online: onlineOf(d.last_seen) && d.status !== 'revoked'
    })));
  }
  if (path === 'control/devices/pairing-code' && method === 'POST') {
    const b = await body();
    const wsId = str(b.workspace_id || '', 64);
    const ws = await get(env, "SELECT * FROM cx_workspaces WHERE id = ? AND status = 'active'", wsId);
    if (!ws) return fail('Choose an active workspace for this pairing code.', 404);
    const ttl = Math.min(1440, Math.max(5, Number(b.ttl_minutes || 60)));
    const code = pairingCode();
    const id = uuid();
    await insert(env, 'cx_pairing_codes', {
      id, code, workspace_id: ws.id, created_by: op.id, device_id: null,
      expires_at: new Date(Date.now() + ttl * 60000).toISOString(), used_at: null, created_at: nowIso()
    });
    await auditOp(env, op, 'create pairing code', 'workspace', ws.id, { ttl_minutes: ttl });
    return json({ ok: true, code, workspace: publicWorkspace(ws), expires_in_minutes: ttl }, 201);
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
      await update(env, 'cx_devices', { is_primary: 0 }, 'workspace_id = ?', device.workspace_id);
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
    if (q.get('workspace_id')) { conds.push('j.workspace_id = ?'); binds.push(q.get('workspace_id')); }
    if (q.get('client_id')) { conds.push('j.client_id = ?'); binds.push(q.get('client_id')); }
    if (q.get('search')) { conds.push('(j.to_phone LIKE ? OR j.recipient_name LIKE ? OR j.message_body LIKE ? OR j.subject LIKE ?)'); const s = `%${str(q.get('search'), 80)}%`; binds.push(s, s, s, s); }
    if (q.get('since')) { conds.push('j.created_at >= ?'); binds.push(q.get('since')); }
    const limit = Math.min(200, Math.max(1, Number(q.get('limit') || 50)));
    const offset = Math.max(0, Number(q.get('offset') || 0));
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await all(env,
      `SELECT j.*, c.name AS client_name, c.client_key, w.name AS workspace_name, w.code AS workspace_code, d.device_name
         FROM cx_jobs j
         LEFT JOIN cx_clients c ON c.id = j.client_id
         LEFT JOIN cx_workspaces w ON w.id = j.workspace_id
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
    const ws = await get(env, "SELECT * FROM cx_workspaces WHERE id = ? AND status = 'active'", str(b.workspace_id || ''));
    if (!ws) return fail('Choose an active workspace.', 404);
    const phone = cleanPhone(b.to || b.phone);
    const messageBody = str(b.message || '', 1600);
    if (!phone) return fail('A valid destination phone number is required.', 400);
    if (!messageBody) return fail('Message text is required.', 400);
    const row = smsJobRow({
      workspaceId: ws.id, clientId: null, apiKeyId: null,
      phone, name: b.recipient_name, recipientType: 'manual',
      messageType: b.message_type || 'Console Message', eventType: b.event_type || 'CONSOLE',
      referenceId: b.reference_id, referenceNumber: b.reference_number,
      messageBody, idempotencyKey: `CONSOLE:${uuid()}`
    });
    await insert(env, 'cx_jobs', row);
    await auditOp(env, op, 'queue manual SMS', 'job', row.id, { to: phone, workspace: ws.code });
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

  /* ---------------- clients & API keys -------------------------------- */
  if (path === 'control/clients' && method === 'GET') {
    const rows = await all(env, 'SELECT * FROM cx_clients ORDER BY created_at ASC');
    const keyRows = await all(env, "SELECT id, client_id, label, key_prefix, workspace_id, daily_limit, status, last_used_at, created_at FROM cx_api_keys ORDER BY created_at DESC");
    const usage = await all(env, `SELECT client_id, status, COUNT(*) AS n FROM cx_jobs
      WHERE created_at >= ? GROUP BY client_id, status`, new Date(Date.now() - 30 * 86400000).toISOString());
    const workspaces = await all(env, 'SELECT id, name, code FROM cx_workspaces');
    const wsMap = Object.fromEntries(workspaces.map(w => [w.id, w]));
    const usageMap = {};
    for (const u of usage) {
      usageMap[u.client_id] ||= { sent: 0, failed: 0, pending: 0, cancelled: 0 };
      if (u.status === 'sent') usageMap[u.client_id].sent += u.n;
      else if (u.status === 'failed') usageMap[u.client_id].failed += u.n;
      else if (u.status === 'cancelled') usageMap[u.client_id].cancelled += u.n;
      else usageMap[u.client_id].pending += u.n;
    }
    return json(rows.map(c => ({
      id: c.id, client_key: c.client_key, name: c.name, description: c.description,
      webhook_url: c.webhook_url, status: c.status, created_at: c.created_at,
      usage30d: usageMap[c.id] || { sent: 0, failed: 0, pending: 0, cancelled: 0 },
      keys: keyRows.filter(k => k.client_id === c.id).map(k => ({
        ...k, workspace: k.workspace_id ? wsMap[k.workspace_id] || null : null
      }))
    })));
  }
  if (path === 'control/clients' && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can add client products.', 403);
    const b = await body();
    const name = str(b.name || '', 120);
    const key = str(b.client_key || name.toLowerCase().replace(/[^a-z0-9]+/g, ''), 40).replace(/[^a-z0-9_]/g, '');
    if (!name || !/^[a-z0-9_]{2,40}$/.test(key)) return fail('Name and a slug client_key (a-z, 0-9, _) are required.', 400);
    const dup = await get(env, 'SELECT id FROM cx_clients WHERE client_key = ?', key);
    if (dup) return fail('That client_key already exists.', 409);
    const id = uuid();
    await insert(env, 'cx_clients', {
      id, client_key: key, name, description: str(b.description || '', 500),
      webhook_url: null, status: 'active', created_at: nowIso(), updated_at: nowIso()
    });
    await auditOp(env, op, 'add client product', 'client', id, { name, client_key: key });
    return json({ ok: true, client: await get(env, 'SELECT * FROM cx_clients WHERE id = ?', id) }, 201);
  }
  if (path.match(/^control\/clients\/[^/]+$/) && method === 'PATCH') {
    const id = decodeURIComponent(path.split('/')[2]);
    const client = await get(env, 'SELECT * FROM cx_clients WHERE id = ?', id);
    if (!client) return fail('Client not found.', 404);
    const b = await body();
    const patch = { updated_at: nowIso() };
    if (b.name !== undefined) patch.name = str(b.name, 120) || client.name;
    if (b.description !== undefined) patch.description = str(b.description, 500);
    if (b.status !== undefined && ['active', 'disabled'].includes(b.status)) patch.status = b.status;
    if (b.webhook_url !== undefined) {
      const wu = str(b.webhook_url, 500);
      if (wu && !/^https:\/\//.test(wu)) return fail('Webhook URL must be https:// or empty.', 400);
      patch.webhook_url = wu || null;
    }
    await update(env, 'cx_clients', patch, 'id = ?', id);
    await auditOp(env, op, 'update client product', 'client', id, { fields: Object.keys(b) });
    return json({ ok: true, client: await get(env, 'SELECT * FROM cx_clients WHERE id = ?', id) });
  }
  if (path.match(/^control\/clients\/[^/]+\/keys$/) && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can issue API keys.', 403);
    const id = decodeURIComponent(path.split('/')[2]);
    const client = await get(env, 'SELECT * FROM cx_clients WHERE id = ?', id);
    if (!client) return fail('Client not found.', 404);
    const b = await body();
    let wsId = null;
    if (b.workspace_id) {
      const ws = await get(env, 'SELECT id FROM cx_workspaces WHERE id = ?', str(b.workspace_id));
      if (!ws) return fail('Workspace not found.', 404);
      wsId = ws.id;
    }
    const plain = clientApiKey();
    const row = {
      id: uuid(), client_id: client.id, workspace_id: wsId,
      label: str(b.label || 'Default key', 120),
      key_prefix: plain.slice(0, 16),
      key_hash: await sha256(plain),
      daily_limit: Math.max(0, Number(b.daily_limit ?? Number(env.DEFAULT_DAILY_LIMIT || 1000))),
      status: 'active', last_used_at: null, created_at: nowIso(), revoked_at: null
    };
    await insert(env, 'cx_api_keys', row);
    await auditOp(env, op, 'issue API key', 'client', client.id, { label: row.label, prefix: row.key_prefix });
    // The plain key is returned exactly once.
    return json({ ok: true, api_key: plain, key: { ...row, key_hash: undefined } }, 201);
  }
  if (path.match(/^control\/keys\/[^/]+\/revoke$/) && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can revoke API keys.', 403);
    const id = decodeURIComponent(path.split('/')[2]);
    const k = await get(env, 'SELECT * FROM cx_api_keys WHERE id = ?', id);
    if (!k) return fail('API key not found.', 404);
    await update(env, 'cx_api_keys', { status: 'revoked', revoked_at: nowIso() }, 'id = ?', id);
    await auditOp(env, op, 'revoke API key', 'client', k.client_id, { prefix: k.key_prefix });
    return json({ ok: true });
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
    for (const r of rows) out[r.setting_key] = parseJson(r.setting_value, null);
    out.sms ||= {};
    // merge default templates per workspace for display
    return json({ ...out, defaultTemplates: DEFAULT_TEMPLATES });
  }
  if (path === 'control/settings' && method === 'PATCH') {
    const b = await body();
    for (const key of Object.keys(b)) {
      if (!['sms', 'branding', 'limits'].includes(key)) continue;
      const existing = await get(env, 'SELECT * FROM cx_settings WHERE setting_key = ?', key);
      const merged = key === 'sms'
        ? { ...(parseJson(existing?.setting_value, {}) || {}), ...b[key] }
        : b[key];
      if (existing) await update(env, 'cx_settings', { setting_value: JSON.stringify(merged), updated_at: nowIso() }, 'setting_key = ?', key);
      else await insert(env, 'cx_settings', { setting_key: key, setting_value: JSON.stringify(merged), updated_at: nowIso() });
    }
    await auditOp(env, op, 'update settings', 'settings', null, { keys: Object.keys(b) });
    return json({ ok: true });
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
    workspace_id: j.workspace_id, workspace_name: j.workspace_name || null, workspace_code: j.workspace_code || null,
    client_id: j.client_id || null, client_name: j.client_name || null, client_key: j.client_key || null,
    to_phone: j.to_phone || null,
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
