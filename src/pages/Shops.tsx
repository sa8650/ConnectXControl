import React, { useCallback, useEffect, useState } from 'react';
import { api, Shop, SystemInfo } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select, Spinner, fmtDate, toast
} from '../components/ui';

export default function Shops() {
  const { operator } = useAuth();
  const isOwner = operator?.role === 'owner';
  const [rows, setRows] = useState<Shop[] | null>(null);
  const [systems, setSystems] = useState<SystemInfo[]>([]);
  const [error, setError] = useState('');
  const [systemFilter, setSystemFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Shop | null>(null);
  const [form, setForm] = useState({ system_id: '', external_id: '', name: '', shop_code: '', address: '', phone: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (systemFilter) q.set('system_id', systemFilter);
      if (statusFilter) q.set('status', statusFilter);
      if (search.trim()) q.set('search', search.trim());
      const [shops, sys] = await Promise.all([
        api.get<Shop[]>(`control/shops?${q.toString()}`),
        api.get<SystemInfo[]>('control/systems')
      ]);
      setRows(shops); setSystems(sys); setError('');
    } catch (e: any) { setError(e?.message || 'Failed to load shops.'); }
  }, [systemFilter, statusFilter, search]);
  useEffect(() => { load(); }, [load]);

  function startCreate() {
    setEditing(null);
    setForm({ system_id: systems[0]?.id || '', external_id: '', name: '', shop_code: '', address: '', phone: '' });
    setOpen(true);
  }
  function startEdit(s: Shop) {
    setEditing(s);
    setForm({ system_id: s.system_id, external_id: s.external_id, name: s.name, shop_code: s.shop_code || '', address: s.address || '', phone: s.phone || '' });
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`control/shops/${encodeURIComponent(editing.id)}`, { name: form.name, shop_code: form.shop_code });
        toast('Shop updated');
      } else {
        await api.post('control/shops', form);
        toast('Shop registered');
      }
      setOpen(false); load();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  async function toggleStatus(s: Shop) {
    const next = s.status === 'active' ? 'paused' : 'active';
    try {
      await api.patch(`control/shops/${encodeURIComponent(s.id)}`, { status: next });
      toast(`Shop ${next === 'paused' ? 'paused' : 'resumed'}`);
      load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  async function remove(s: Shop) {
    if (!confirm(`Delete “${s.name}”? Only possible while it has no devices or message history.`)) return;
    try {
      await api.del(`control/shops/${encodeURIComponent(s.id)}`);
      toast('Shop deleted'); load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  if (error) return <Card title="Shops"><div className="form-error">{error}</div></Card>;
  if (!rows) return <div className="center-screen"><Spinner /></div>;

  return (
    <>
      <PageHead
        title="Shops"
        subtitle="Shops and branches live inside the connected systems (EMS, CareOS…). They sync automatically when an administrator signs in on the ConnectX phone app; gateway devices pair to a shop and messages are delivered for it."
        actions={<Button onClick={startCreate}>＋ Register shop</Button>}
      />
      <Card>
        <div className="pill-row" style={{ marginBottom: 12 }}>
          <Select value={systemFilter} onChange={e => setSystemFilter(e.target.value)}>
            <option value="">All systems</option>
            {systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </Select>
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name / id / code…" style={{ maxWidth: 240 }} />
        </div>
        {rows.length === 0 ? <Empty>No shops match. They appear automatically after an administrator signs in on the phone app.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Shop</th><th>System</th><th>System ID / code</th><th>Contact</th><th>Gateways</th><th>Status</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {rows.map(s => (
                  <tr key={s.id}>
                    <td className="td-main">{s.name}{s.category ? <div className="td-sub">{s.category}</div> : null}</td>
                    <td>{s.system_name || <span className="td-sub">—</span>}</td>
                    <td>
                      <div className="mono">{s.external_id}</div>
                      {s.shop_code ? <div className="td-sub mono">{s.shop_code}</div> : null}
                    </td>
                    <td>
                      <div className="td-sub">{s.phone || '—'}</div>
                      <div className="td-sub">{s.address || ''}</div>
                    </td>
                    <td>{s.devices || 0} paired · <span style={{ color: (s.online || 0) > 0 ? 'var(--good)' : 'var(--muted)' }}>{s.online || 0} online</span></td>
                    <td><Badge value={s.status || 'active'} />{s.system_status && s.system_status !== 'active' ? <div className="td-sub">system: {s.system_status}</div> : null}</td>
                    <td className="td-sub">{fmtDate(s.created_at)}</td>
                    <td>
                      <div className="pill-row">
                        <Button variant="ghost" onClick={() => startEdit(s)}>Edit</Button>
                        <Button variant={s.status === 'active' ? 'danger' : 'soft'} onClick={() => toggleStatus(s)}>
                          {s.status === 'active' ? 'Pause' : 'Resume'}
                        </Button>
                        {isOwner && (s.devices || 0) === 0 && <Button variant="ghost" onClick={() => remove(s)}>Delete</Button>}
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
        <Modal title={editing ? `Edit “${editing.name}”` : 'Register shop manually'} onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            {!editing && <>
              <Field label="System" hint="Shops normally sync from the system when an administrator signs in on the phone app. Register manually only to prepare pairing in advance.">
                <Select value={form.system_id} onChange={e => setForm({ ...form, system_id: e.target.value })} required>
                  {systems.map(s => <option key={s.id} value={s.id}>{s.name} ({s.system_key})</option>)}
                </Select>
              </Field>
              <Field label="Shop ID inside the system" hint="The external_id the system uses for this shop (e.g. its store id).">
                <Input value={form.external_id} onChange={e => setForm({ ...form, external_id: e.target.value })} placeholder="store-42" required />
              </Field>
            </>}
            <Field label="Name">
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Dhaka Main Branch" required autoFocus />
            </Field>
            <Field label="Shop code" hint="Optional short code shown in SMS templates.">
              <Input value={form.shop_code} onChange={e => setForm({ ...form, shop_code: e.target.value })} placeholder="DHK-1" />
            </Field>
            {!editing && <div className="form-row">
              <Field label="Phone">
                <Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+880…" />
              </Field>
              <Field label="Address">
                <Input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
              </Field>
            </div>}
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Register shop'}</Button>
          </form>
        </Modal>
      )}
    </>
  );
}
