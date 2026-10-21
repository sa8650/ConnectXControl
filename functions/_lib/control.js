/* =====================================================================
   ConnectX Control API — account management, provider email, audit, Android
   release management, and local app telemetry monitoring.
   The retired systems/pairing/device/SMS queue APIs are blocked in the
   public router; legacy records are retained for compatibility and history.
   ===================================================================== */
import { all, get, insert, update, run, parseJson } from './db.js';
import {
  json, fail, uuid, nowIso, str, bool, isEmail, isUuid, isVersion, isPackage,
  signToken, verifyToken, bearerOf, hashPassword, checkPassword
} from './core.js';
import { logActivity, recentActivity } from './audit.js';
import { apkKey, getReleaseBucket, releaseStatus, downloadPath } from './releases.js';
import { emailConfig, providerList, sendEmail } from './email.js';
import { controlMonitorRoutes } from './telemetry.js';

const CONTROL_TTL = 60 * 60 * 12; // 12h control-panel sessions

function publicOperator(op) {
  if (!op) return null;
  return {
    id: op.id,
    admin_code: op.operator_code || null,
    name: op.name || '',
    email: op.email || '',
    phone: op.phone || '',
    address: op.address || '',
    role: op.role || 'operator',
    active: bool(op.active),
    created_at: op.created_at || null
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

/* ===================================================================== */
export async function controlRoutes(ctx) {
  const { env, request, path, method, url } = ctx;
  let parsedBody;
  let bodyRead = false;
  const body = async () => {
    if (bodyRead) return parsedBody;
    bodyRead = true;
    try { parsedBody = await request.json(); } catch { parsedBody = {}; }
    return parsedBody;
  };

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

  const monitorResponse = await controlMonitorRoutes({
    env, path, method, op, body: {}, url
  });
  if (monitorResponse) return monitorResponse;

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
    const dup = await get(env, 'SELECT id FROM cx_releases WHERE package_name = ? AND version_code = ?', pkg, code);
    if (dup) return fail('That build number already exists. Edit that release instead of creating a new one.', 409);
    const latest = await get(env, 'SELECT version_code FROM cx_releases WHERE package_name = ? ORDER BY version_code DESC LIMIT 1', pkg);
    if (latest && code < Number(latest.version_code)) return fail('version_code cannot be lower than the current release.', 409);
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
    const id = uuid();
    await insert(env, 'cx_releases', { id, ...record, created_at: nowIso() });
    const saved = await get(env, 'SELECT * FROM cx_releases WHERE id = ?', id);
    await auditOp(env, op, 'create release', 'release', saved.id, { package_name: pkg, version, version_code: code, published: record.published });
    return json({ ok: true, release: { ...saved, download_available: (await releaseStatus(env, saved)).available } }, 201);
  }
  if (path === 'control/releases/discard' && method === 'POST') {
    if (!ownerOnly(op)) return fail('Only the owner can discard uploads.', 403);
    const b = await body();
    const key = str(b.apk_r2_key || '', 500);
    if (!apkKey({ apk_r2_key: key, package_name: key.split('/')[1] || '' })) return fail('Invalid APK key.', 400);
    const used = await get(env, 'SELECT id FROM cx_releases WHERE apk_r2_key = ?', key);
    if (used) return fail('That file is already attached to a release.', 409);
    const bucket = getReleaseBucket(env);
    if (bucket) { try { await bucket.delete(key); } catch {} }
    return json({ ok: true, discarded: true });
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
      if (rel.apk_r2_key) {
        const still = await get(env, 'SELECT id FROM cx_releases WHERE apk_r2_key = ?', rel.apk_r2_key);
        const bucket = getReleaseBucket(env);
        if (!still && bucket) { try { await bucket.delete(rel.apk_r2_key); } catch {} }
      }
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
    if (b.apk_r2_key !== undefined) {
      const key = str(b.apk_r2_key || '', 500);
      if (key && !apkKey({ apk_r2_key: key, package_name: rel.package_name })) return fail('APK storage key must belong to this package.', 400);
      patch.apk_r2_key = key || null;
    }
    if (b.apk_filename !== undefined) patch.apk_filename = str(b.apk_filename, 180);
    if (b.apk_size_bytes !== undefined) patch.apk_size_bytes = Math.max(0, Number(b.apk_size_bytes || 0));
    if (patch.published === 1 || (patch.published === undefined && bool(rel.published))) {
      const status = await releaseStatus(env, { ...rel, ...patch });
      if (!status.available) return fail('Cannot keep published without a downloadable APK.', 422);
    }
    await update(env, 'cx_releases', patch, 'id = ?', id);
    if (patch.apk_r2_key !== undefined && rel.apk_r2_key && patch.apk_r2_key !== rel.apk_r2_key) {
      const still = await get(env, 'SELECT id FROM cx_releases WHERE apk_r2_key = ?', rel.apk_r2_key);
      const bucket = getReleaseBucket(env);
      if (!still && bucket) { try { await bucket.delete(rel.apk_r2_key); } catch {} }
    }
    await auditOp(env, op, 'update release', 'release', id, { fields: Object.keys(b) });
    const saved = await get(env, 'SELECT * FROM cx_releases WHERE id = ?', id);
    return json({ ok: true, release: { ...saved, download_available: (await releaseStatus(env, saved)).available } });
  }

  /* ---------------- settings ------------------------------------------ */
  if (path === 'control/settings' && method === 'GET') {
    const rows = await all(env, 'SELECT * FROM cx_settings');
    const out = {};
    // The email provider config (incl. its API key) is owner-only and served
    // masked by GET control/email — never leak it through generic settings.
    for (const r of rows) if (r.setting_key !== 'email') out[r.setting_key] = parseJson(r.setting_value, null);
    delete out.sms; // legacy SMS templates are retained in D1 but no longer exposed or used.
    return json(out);
  }
  if (path === 'control/settings' && method === 'PATCH') {
    const b = await body();
    if (Object.hasOwn(b, 'sms'))
      return fail('SMS templates are managed in EMS and are no longer configurable in ConnectX Control.', 410);
    await auditOp(env, op, 'update settings', 'settings', null, { keys: [] });
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
