import React, { useCallback, useEffect, useState } from 'react';
import { api, Workspace } from '../api/client';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Spinner, fmtDate, toast
} from '../components/ui';

export default function Workspaces() {
  const [rows, setRows] = useState<Workspace[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [form, setForm] = useState({ name: '', code: '', address: '', phone: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await api.get<Workspace[]>('control/workspaces')); setError(''); }
    catch (e: any) { setError(e?.message || 'Failed to load workspaces.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function startCreate() { setEditing(null); setForm({ name: '', code: '', address: '', phone: '' }); setOpen(true); }
  function startEdit(w: Workspace) {
    setEditing(w);
    setForm({ name: w.name, code: w.code, address: w.address || '', phone: w.phone || '' });
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`control/workspaces/${encodeURIComponent(editing.id)}`, form);
        toast('Workspace updated');
      } else {
        await api.post('control/workspaces', form);
        toast('Workspace created');
      }
      setOpen(false); load();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  async function toggleStatus(w: Workspace) {
    const next = w.status === 'active' ? 'paused' : 'active';
    try {
      await api.patch(`control/workspaces/${encodeURIComponent(w.id)}`, { status: next });
      toast(`Workspace ${next === 'paused' ? 'paused' : 'resumed'}`);
      load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  if (error) return <Card title="Workspaces"><div className="form-error">{error}</div></Card>;
  if (!rows) return <div className="center-screen"><Spinner /></div>;

  return (
    <>
      <PageHead
        title="Workspaces"
        subtitle="A workspace is one tenant of the gateway (a shop, branch, organization or product environment). Devices pair to a workspace; client apps push jobs into it."
        actions={<Button onClick={startCreate}>＋ New workspace</Button>}
      />
      <Card>
        {rows.length === 0 ? <Empty>No workspaces yet — create the first one.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Code</th><th>Contact</th><th>Gateways</th><th>Status</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {rows.map(w => (
                  <tr key={w.id}>
                    <td className="td-main">{w.name}</td>
                    <td className="mono">{w.code}</td>
                    <td>
                      <div className="td-sub">{w.phone || '—'}</div>
                      <div className="td-sub">{w.address || ''}</div>
                    </td>
                    <td>{w.devices || 0} paired · <span style={{ color: w.online ? 'var(--good)' : 'var(--muted)' }}>{w.online || 0} online</span></td>
                    <td><Badge value={w.status || 'active'} /></td>
                    <td className="td-sub">{fmtDate(w.created_at)}</td>
                    <td>
                      <div className="pill-row">
                        <Button variant="ghost" onClick={() => startEdit(w)}>Edit</Button>
                        <Button variant={w.status === 'active' ? 'danger' : 'soft'} onClick={() => toggleStatus(w)}>
                          {w.status === 'active' ? 'Pause' : 'Resume'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && (
        <Modal title={editing ? `Edit “${editing.name}”` : 'New workspace'} onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            <Field label="Name">
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Dhaka Main Branch" required autoFocus />
            </Field>
            <Field label="Code" hint="Unique identifier used by client apps (leave blank to auto-generate).">
              <Input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="DHAKA-MAIN" />
            </Field>
            <div className="form-row">
              <Field label="Phone">
                <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+880…" />
              </Field>
              <Field label="Address">
                <Input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
              </Field>
            </div>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create workspace'}</Button>
          </form>
        </Modal>
      )}
    </>
  );
}
