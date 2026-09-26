/* =====================================================================
   ConnectX Releases — the platform's OWN update channel.

   The Android gateway checks `public/releases/check` on the ConnectX
   Control website (never on EMS). APKs are stored in the ConnectX R2
   bucket under releases/<package>/... or referenced by external HTTPS
   URL. Release management lives in control.js (owner only).
   ===================================================================== */
import { all, get } from './db.js';
import { json, fail, bool, isPackage } from './core.js';

export const getReleaseBucket = env => env.APP_STORAGE || env.RELEASES_BUCKET || null;

export const apkKey = row => {
  const key = row?.apk_r2_key;
  return typeof key === 'string' && key.startsWith(`releases/${row.package_name}/`) && !key.split('/').includes('..') ? key : null;
};

function externalApkUrl(row) {
  try {
    const u = new URL(row.apk_url);
    if (u.protocol !== 'https:' || u.username || u.password ||
        /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}

/** A release is downloadable only when a real binary exists. */
export async function releaseStatus(env, row) {
  const key = apkKey(row), bucket = getReleaseBucket(env);
  if (key) {
    if (!bucket) return { available: false };
    try {
      const object = await bucket.head(key);
      return { available: !!object && Number(object.size) > 0, source: 'r2', key };
    } catch (e) {
      console.error('ConnectX release R2 HEAD failed:', e);
      return { available: false };
    }
  }
  const external = externalApkUrl(row);
  if (!external) return { available: false };
  try {
    const res = await fetch(external, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(7000) });
    const type = res.headers.get('content-type') || '';
    const length = res.headers.get('content-length');
    return {
      available: res.ok && !/text\/html|application\/json/i.test(type) && (length === null || Number(length) > 0),
      source: 'external', url: external
    };
  } catch (e) {
    console.error('ConnectX release external APK check failed:', e);
    return { available: false };
  }
}

export const downloadPath = row => `/api/public/releases/download/${encodeURIComponent(row.package_name)}`;

const publishedReleases = async env => {
  const rows = await all(env, 'SELECT * FROM cx_releases WHERE published = 1');
  const byPackage = new Map();
  for (const r of rows.sort((a, b) => Number(b.version_code) - Number(a.version_code))) {
    const pkg = String(r.package_name || '').toLowerCase();
    if (pkg && !byPackage.has(pkg)) byPackage.set(pkg, r);
  }
  return [...byPackage.values()];
};

const filename = v => String(v || 'connectx.apk').replace(/[\r\n\\/"]/g, '_').slice(0, 180);
const disposition = v => `attachment; filename="${filename(v).replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename(v))}`;

/* ---------------- public (unauthenticated) routes ---------------------- */
export async function publicReleaseRoutes({ env, request, path, method, url }) {
  if (path === 'public/health' && method === 'GET')
    return json({ ok: true, service: 'connectx-control', time: new Date().toISOString() });

  const listing = path === 'public/releases';
  const checking = path === 'public/releases/check';
  const downloading = path.startsWith('public/releases/download/');
  if (!listing && !checking && !downloading) return null;
  if (method !== 'GET' && !(downloading && method === 'HEAD')) return fail('Method not allowed.', 405);

  const releases = await publishedReleases(env);

  if (listing) {
    const out = [];
    for (const r of releases) {
      const status = await releaseStatus(env, r);
      out.push({
        id: r.id, package_name: r.package_name, title: r.title, description: r.description,
        version: r.version, version_code: Number(r.version_code), mandatory: bool(r.mandatory),
        release_notes: r.release_notes, apk_filename: r.apk_filename,
        apk_size_bytes: Number(r.apk_size_bytes || 0), updated_at: r.updated_at,
        download_available: status.available,
        download_url: status.available ? downloadPath(r) : null
      });
    }
    return json(out);
  }

  if (checking) {
    const params = url.searchParams;
    const pkg = (params.get('package') || 'com.connectx.gateway').trim();
    if (!isPackage(pkg)) return fail('Invalid package name.', 400);
    const release = releases.find(r => r.package_name.toLowerCase() === pkg.toLowerCase());
    if (!release) return fail('No published release for this app.', 404);
    const status = await releaseStatus(env, release);
    if (!status.available)
      return fail('The latest release is registered, but its APK is not downloadable. Upload a signed APK in ConnectX Control → Releases.', 503);
    const installed = Number(params.get('versionCode') ?? params.get('version_code') ?? 0);
    const versionCode = Number(release.version_code);
    const downloadUrl = new URL(downloadPath(release), request.url).href;
    // Response keys mirror what the ConnectX Android app parses.
    return json({
      ok: true,
      hasUpdate: versionCode > (Number.isSafeInteger(installed) && installed >= 0 ? installed : 0),
      title: release.title,
      description: release.description,
      latestVersion: release.version, version: release.version,
      versionCode, version_code: versionCode,
      mandatory: bool(release.mandatory),
      downloadUrl, download_url: downloadUrl,
      apk_filename: release.apk_filename || `${release.package_name}-${release.version}.apk`,
      apk_size_bytes: Number(release.apk_size_bytes || 0),
      releaseNotes: release.release_notes || '', release_notes: release.release_notes || '',
      updated_at: release.updated_at
    });
  }

  /* download */
  let id;
  try { id = decodeURIComponent(path.slice('public/releases/download/'.length)); } catch { return fail('Invalid release id.', 400); }
  const release = releases.find(r => r.id === id || r.package_name.toLowerCase() === id.toLowerCase());
  if (!release) return fail('Release not found.', 404);
  const status = await releaseStatus(env, release);
  if (!status.available) return fail('APK file is not available. Upload a signed APK in ConnectX Control → Releases.', 503);
  if (status.source === 'external') return Response.redirect(status.url, 302);
  const bucket = getReleaseBucket(env);
  const object = method === 'HEAD' ? await bucket.head(status.key) : await bucket.get(status.key);
  if (!object || !object.size) return fail('APK file is missing from storage.', 503);
  return new Response(method === 'HEAD' ? null : object.body, {
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': disposition(release.apk_filename || `${release.package_name}.apk`),
      'content-length': String(object.size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}
