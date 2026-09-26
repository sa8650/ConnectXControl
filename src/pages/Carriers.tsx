import React, { useCallback, useEffect, useState } from 'react';
import { api, Carrier } from '../api/client';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Spinner, toast
} from '../components/ui';

export default function Carriers() {
  const [rows, setRows] = useState<Carrier[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Carrier | null>(null);
  const [form, setForm] = useState({ carrier_name: '', carrier_identifier: '', mcc_mnc: '', balance_ussd_code: '', balance_pattern: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await api.get<Carrier[]>('control/carriers')); setError(''); }
    catch (e: any) { setError(e?.message || 'Failed to load carriers.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function startCreate() {
    setEditing(null);
    setForm({ carrier_name: '', carrier_identifier: '', mcc_mnc: '', balance_ussd_code: '', balance_pattern: '' });
    setOpen(true);
  }
  function startEdit(c: Carrier) {
    setEditing(c);
    setForm({
      carrier_name: c.carrier_name, carrier_identifier: c.carrier_identifier || '',
      mcc_mnc: c.mcc_mnc || '', balance_ussd_code: c.balance_ussd_code || '',
      balance_pattern: c.balance_pattern || ''
    });
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (editing) await api.patch(`control/carriers/${encodeURIComponent(editing.id)}`, form);
      else await api.post('control/carriers', form);
      toast(editing ? 'Carrier updated' : 'Carrier added');
      setOpen(false); load();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  async function remove(c: Carrier) {
    if (!confirm(`Delete carrier ${c.carrier_name}?`)) return;
    try { await api.del(`control/carriers/${encodeURIComponent(c.id)}`); toast('Carrier deleted'); load(); }
    catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  if (error) return <Card title="SIM carriers"><div className="form-error">{error}</div></Card>;
  if (!rows) return <div className="center-screen"><Spinner /></div>;

  return (
    <>
      <PageHead
        title="SIM Carrier Catalog"
        subtitle="Owner-managed USSD balance codes. A gateway phone looks up its SIM's carrier here when you tap Refresh on the SIM Balance card — codes are never hard-coded in the app."
        actions={<Button onClick={startCreate}>＋ Add carrier</Button>}
      />
      <Card>
        {rows.length === 0 ? <Empty>No carriers configured. Add e.g. Grameenphone with its *121# balance code.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Carrier</th><th>MCC/MNC</th><th>Balance USSD</th><th>Balance pattern</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map(c => (
                  <tr key={c.id}>
                    <td>
                      <div className="td-main">{c.carrier_name}</div>
                      {c.carrier_identifier && <div className="td-sub">{c.carrier_identifier}</div>}
                    </td>
                    <td className="mono">{c.mcc_mnc || '—'}</td>
                    <td className="mono">{c.balance_ussd_code || '—'}</td>
                    <td className="mono td-sub">{c.balance_pattern || '—'}</td>
                    <td><Badge value={Number(c.active) ? 'active' : 'disabled'} /></td>
                    <td>
                      <div className="pill-row">
                        <Button variant="ghost" onClick={() => startEdit(c)}>Edit</Button>
                        <Button variant="danger" onClick={() => remove(c)}>Delete</Button>
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
        <Modal title={editing ? `Edit ${editing.carrier_name}` : 'Add SIM carrier'} onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            <div className="form-row">
              <Field label="Carrier name">
                <Input value={form.carrier_name} onChange={e => setForm({ ...form, carrier_name: e.target.value })} placeholder="Grameenphone" required autoFocus />
              </Field>
              <Field label="Identifier" hint="Optional SIM name match, e.g. GP.">
                <Input value={form.carrier_identifier} onChange={e => setForm({ ...form, carrier_identifier: e.target.value })} />
              </Field>
            </div>
            <div className="form-row">
              <Field label="MCC/MNC" hint="5–6 digits, e.g. 47001 for GP. Exact match wins.">
                <Input value={form.mcc_mnc} onChange={e => setForm({ ...form, mcc_mnc: e.target.value.replace(/\D/g, '') })} placeholder="47001" />
              </Field>
              <Field label="Balance USSD code" hint="e.g. *121#">
                <Input value={form.balance_ussd_code} onChange={e => setForm({ ...form, balance_ussd_code: e.target.value })} placeholder="*121#" />
              </Field>
            </div>
            <Field label="Balance pattern" hint="Optional regex to extract the amount from the USSD reply.">
              <Input value={form.balance_pattern} onChange={e => setForm({ ...form, balance_pattern: e.target.value })} placeholder="(?:Tk|BDT)\s?([0-9,.]+)" />
            </Field>
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save carrier' : 'Add carrier'}</Button>
          </form>
        </Modal>
      )}
    </>
  );
}
