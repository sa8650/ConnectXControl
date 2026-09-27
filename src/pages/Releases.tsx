import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, Release } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import {
  Badge, Button, Card, CopyButton, Empty, Field, Input, Modal, PageHead,
  Spinner, TextArea, fmtBytes, fmtDate, toast
} from '../components/ui';

const DEFAULT_PACKAGE = 'com.connectx.gateway';

export default function Releases() {
  const { operator } = useAuth();
  const isOwner = operator?.role === 'owner';
  const [rows, setRows] = useState<Release[] | null>(null);
  const [error, setError] = useState('');
  const [pubOpen, setPubOpen] = useState(false);
  const [editing, setEditing] = useState<Release | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api.get<Release[]>('control/releases')); setError(''); }
    catch (e: any) { setError(e?.message || 'Failed to load releases.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function togglePublish(r: Release) {
    try {
      await api.patch(`control/releases/${encodeURIComponent(r.id)}`, { published: !r.published });
      toast(r.published ? 'Release unpublished' : 'Release published — devices can now update');
      load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }
  async function toggleMandatory(r: Release) {
    try {
      await api.patch(`control/releases/${encodeURIComponent(r.id)}`, { mandatory: !r.mandatory });
      toast(r.mandatory ? 'Update is now optional' : 'Update is now mandatory');
      load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }
  async function remove(r: Release) {
    if (!confirm(`Delete release ${r.version} (build ${r.version_code}) for ${r.package_name}?`)) return;
    try {
      await api.del(`control/releases/${encodeURIComponent(r.id)}`);
      toast('Release deleted'); load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  if (error) return <Card title="Releases"><div className="form-error">{error}</div></Card>;
  if (!rows) return <div className="center-screen"><Spinner /></div>;

  return (
    <>
      <PageHead
        title="App Releases"
        subtitle="ConnectX's own update channel. Android gateways check this website for updates — never another product's app store."
        actions={isOwner ? <Button onClick={() => { setEditing(null); setPubOpen(true); }}>＋ Publish release</Button> : undefined}
      />

      <Card title="Update endpoint used by the Android app">
        <p className="muted" style={{ marginTop: 0 }}>
          The gateway app polls this public URL (no auth). Configure the app with this website's URL only.
        </p>
        <pre className="code">GET {window.location.origin}/api/public/releases/check?package=${DEFAULT_PACKAGE}&versionCode=18</pre>
        <div className="pill-row"><CopyButton value={`${window.location.origin}/api/public/releases/check?package=${DEFAULT_PACKAGE}&versionCode=18`} label="Copy check URL" /></div>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <Empty>
            No releases yet. Build a signed ConnectX APK, then publish it here — devices will pick up
            the update automatically (optionally as a mandatory update).
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>App</th><th>Version</th><th>APK</th><th>Flags</th><th>State</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td>
                      <div className="td-main">{r.title || r.package_name}</div>
                      <div className="td-sub mono">{r.package_name}</div>
                    </td>
                    <td>
                      <div className="td-main">{r.version}</div>
                      <div className="td-sub">build {r.version_code}</div>
                    </td>
                    <td>
                      <div className="td-sub">{r.apk_filename || '—'}</div>
                      <div className="td-sub">{fmtBytes(r.apk_size_bytes)} {r.apk_r2_key ? '· R2' : r.apk_url ? '· external URL' : '· no binary'}</div>
                    </td>
                    <td>{r.mandatory ? <Badge value="mandatory" tone="warn" /> : <Badge value="optional" tone="muted" />}</td>
                    <td>
                      <Badge value={r.published ? 'published' : 'draft'} />{' '}
                      {r.published && (r.download_available
                        ? <Badge value="downloadable" />
                        : <Badge value="apk missing" tone="bad" />)}
                    </td>
                    <td className="td-sub">{fmtDate(r.updated_at)}</td>
                    <td>
                      {isOwner && <div className="pill-row">
                        <Button variant="ghost" onClick={() => { setEditing(r); setPubOpen(true); }}>Edit</Button>
                        <Button variant={r.published ? 'danger' : 'soft'} onClick={() => togglePublish(r)}>
                          {r.published ? 'Unpublish' : 'Publish'}
                        </Button>
                        <Button variant="ghost" onClick={() => toggleMandatory(r)}>{r.mandatory ? 'Make optional' : 'Make mandatory'}</Button>
                        <Button variant="ghost" onClick={() => remove(r)}>Delete</Button>
                      </div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pubOpen && <PublishForm release={editing} onClose={() => setPubOpen(false)} onSaved={() => { setPubOpen(false); load(); }} />}
    </>
  );
}

function PublishForm({ release, onClose, onSaved }: { release: Release | null; onClose: () => void; onSaved: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    package_name: release?.package_name || DEFAULT_PACKAGE,
    title: release?.title || 'ConnectX: Central Communication Gateway powered by Dexter Studio',
    version: release?.version || '',
    version_code: String(release?.version_code ?? ''),
    release_notes: release?.release_notes || '',
    description: release?.description || '',
    apk_url: release?.apk_url || '',
    mandatory: !!release?.mandatory,
    published: !!release?.published
  });
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    let uploadedKey = '';
    try {
      let apk_r2_key = release?.apk_r2_key || '';
      let apk_filename = release?.apk_filename || `${form.package_name}-${form.version}.apk`;
      let apk_size_bytes = release?.apk_size_bytes || 0;
      if (pendingFile) {
        const fd = new FormData();
        fd.append('file', pendingFile);
        fd.append('package_name', form.package_name);
        const res = await api.upload<{ apk_r2_key: string; filename: string; size_bytes: number }>('control/releases/upload', fd);
        uploadedKey = res.apk_r2_key;
        apk_r2_key = res.apk_r2_key;
        apk_filename = res.filename;
        apk_size_bytes = res.size_bytes;
      }
      const payload = {
        ...form,
        version_code: Number(form.version_code),
        apk_r2_key: apk_r2_key || undefined,
        apk_filename,
        apk_size_bytes
      };
      if (release) await api.patch(`control/releases/${release.id}`, payload);
      else await api.post('control/releases', payload);
      toast(form.published ? 'Release published' : 'Release saved as draft');
      onSaved();
    } catch (err: any) {
      if (uploadedKey) {
        await api.post('control/releases/discard', { apk_r2_key: uploadedKey }).catch(() => {});
      }
      toast(err?.message || 'Failed', 'err');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={release ? `Edit release ${release.version}` : 'Publish ConnectX release'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Android package">
            <Input value={form.package_name} onChange={e => setForm({ ...form, package_name: e.target.value })} required disabled={!!release} />
          </Field>
          <Field label="Title">
            <Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Version name" hint="e.g. 2.0.0">
            <Input value={form.version} onChange={e => setForm({ ...form, version: e.target.value })} placeholder="2.0.0" required />
          </Field>
          <Field label="Version code (build)" hint="Positive integer; must increase.">
            <Input type="number" min={1} value={form.version_code} onChange={e => setForm({ ...form, version_code: e.target.value })} placeholder="18" required />
          </Field>
        </div>
        <Field label="Signed APK" hint={pendingFile ? `Will upload on save: ${pendingFile.name} (${fmtBytes(pendingFile.size)})` : release?.apk_filename ? `Current file stays until you choose a new one: ${release.apk_filename}` : 'The file is uploaded only when you create or save the release.'}>
          <input ref={fileRef} type="file" accept=".apk" className="input"
            onChange={e => setPendingFile(e.target.files?.[0] || null)} />
        </Field>
        <Field label="…or external HTTPS APK URL" hint="Alternative to the upload (e.g. your own CDN). Leave empty when uploading.">
          <Input value={form.apk_url} onChange={e => setForm({ ...form, apk_url: e.target.value })} placeholder="https://cdn.example.com/ConnectX-2.0.0.apk" />
        </Field>
        <Field label="Release notes">
          <TextArea value={form.release_notes} onChange={e => setForm({ ...form, release_notes: e.target.value })} placeholder="What changed in this build…" />
        </Field>
        <Field label="Description">
          <TextArea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={form.mandatory} onChange={e => setForm({ ...form, mandatory: e.target.checked })} />
          Mandatory update (the app blocks usage until updated)
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.published} onChange={e => setForm({ ...form, published: e.target.checked })} />
          Publish immediately (requires a downloadable APK)
        </label>
        {busy && <p className="muted">Saving release…</p>}
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : release ? 'Save release' : 'Create release'}</Button>
      </form>
    </Modal>
  );
}
