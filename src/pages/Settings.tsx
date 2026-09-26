import React, { useCallback, useEffect, useState } from 'react';
import { api, Operator } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select,
  TextArea, fmtDate, toast
} from '../components/ui';

interface SmsWorkspaceSettings { enabled?: boolean; templates?: Record<string, string> }

export default function Settings() {
  const { operator, refresh } = useAuth();
  const isOwner = operator?.role === 'owner';

  return (
    <>
      <PageHead title="Settings" subtitle="Your account, platform accounts, SMS behaviour and message templates." />
      <div className="grid grid-2">
        <ProfileCard operator={operator!} onSaved={refresh} />
        <PasswordCard />
      </div>
      <SmsSettingsCard />
      {isOwner && <OperatorsCard />}
    </>
  );
}

function ProfileCard({ operator, onSaved }: { operator: Operator; onSaved: () => void }) {
  const [form, setForm] = useState({ name: operator.name, phone: operator.phone || '', address: operator.address || '' });
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await api.patch('control/auth/profile', form); toast('Profile saved'); onSaved(); }
    catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }
  return (
    <Card title="Your profile" subtitle={operator.email}>
      <form onSubmit={submit}>
        <Field label="Name"><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Address"><Input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></Field>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</Button>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.newPassword.length < 10) { toast('New password must be at least 10 characters.', 'err'); return; }
    if (form.newPassword !== form.confirm) { toast('Passwords do not match.', 'err'); return; }
    setBusy(true);
    try {
      await api.patch('control/auth/password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      toast('Password changed'); setForm({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }
  return (
    <Card title="Change password">
      <form onSubmit={submit}>
        <Field label="Current password"><Input type="password" value={form.currentPassword} onChange={e => setForm({ ...form, currentPassword: e.target.value })} required /></Field>
        <Field label="New password" hint="At least 10 characters."><Input type="password" value={form.newPassword} onChange={e => setForm({ ...form, newPassword: e.target.value })} required /></Field>
        <Field label="Confirm new password"><Input type="password" value={form.confirm} onChange={e => setForm({ ...form, confirm: e.target.value })} required /></Field>
        <Button type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</Button>
      </form>
    </Card>
  );
}

function SmsSettingsCard() {
  const [settings, setSettings] = useState<any>(null);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [wsId, setWsId] = useState('');
  const [templates, setTemplates] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const KEYS = ['SALE', 'PAYMENT', 'DUE_REMINDER', 'RETURN', 'EXCHANGE', 'REFUND', 'TEST'];

  const load = useCallback(async () => {
    const [s, w] = await Promise.all([api.get<any>('control/settings'), api.get<any[]>('control/workspaces')]);
    setSettings(s); setWorkspaces(w);
    if (!wsId && w[0]) selectWorkspace(w[0].id, s);
  }, []);
  useEffect(() => { load(); }, [load]);

  function selectWorkspace(id: string, s?: any) {
    setWsId(id);
    const cfg = (s ?? settings)?.sms?.[id] || {};
    setEnabled(cfg.enabled !== false);
    setTemplates({ ...(s ?? settings)?.defaultTemplates, ...(cfg.templates || {}) });
  }

  async function save() {
    setBusy(true);
    try {
      const current = settings?.sms || {};
      await api.patch('control/settings', { sms: { ...current, [wsId]: { enabled, templates } } });
      toast('SMS settings saved for this workspace');
      const s = await api.get<any>('control/settings'); setSettings(s);
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="SMS behaviour & templates"
      subtitle="Per workspace: enable/disable the SMS gateway and edit the templates rendered when apps send typed events without a message body.">
      {!workspaces.length ? <Empty>Create a workspace first.</Empty> : (
        <>
          <div className="filters">
            <Select value={wsId} onChange={e => selectWorkspace(e.target.value)}>
              {workspaces.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
            </Select>
            <label className="checkbox" style={{ margin: 0 }}>
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              SMS gateway enabled for this workspace
            </label>
          </div>
          <p className="muted">
            Placeholders: <span className="mono">{'{name} {shop} {invoice} {total} {paid} {due} {amount} {currency}'}</span>
          </p>
          {KEYS.map(k => (
            <Field key={k} label={k}>
              <TextArea value={templates[k] || ''} onChange={e => setTemplates({ ...templates, [k]: e.target.value })} />
            </Field>
          ))}
          <Button onClick={save} disabled={busy || !wsId}>{busy ? 'Saving…' : 'Save SMS settings'}</Button>
        </>
      )}
    </Card>
  );
}

function OperatorsCard() {
  const { operator } = useAuth();
  const [rows, setRows] = useState<any[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'operator' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRows(await api.get<any[]>('control/operators')); } catch { setRows([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api.post('control/operators', form);
      toast('Account created'); setOpen(false); setForm({ name: '', email: '', password: '', role: 'operator' }); load();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }
  async function toggleActive(o: any) {
    try { await api.patch(`control/operators/${o.id}`, { active: !o.active }); toast('Account updated'); load(); }
    catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  return (
    <Card title="Platform accounts" subtitle="Owner accounts manage apps, keys and releases. Operator accounts manage gateways, workspaces and messages — and can sign in on phones."
      actions={<Button onClick={() => setOpen(true)}>＋ Add account</Button>}>
      {rows === null ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No accounts found.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Code</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody>
              {rows.map(o => (
                <tr key={o.id}>
                  <td className="td-main">{o.name}{o.id === operator?.id && <span className="muted"> (you)</span>}</td>
                  <td>{o.email}</td>
                  <td className="mono td-sub">{o.operator_code}</td>
                  <td><Badge value={o.role} tone={o.role === 'owner' ? 'info' : 'muted'} /></td>
                  <td><Badge value={o.active ? 'active' : 'disabled'} /></td>
                  <td className="td-sub">{o.last_login_at ? fmtDate(o.last_login_at) : 'never'}</td>
                  <td>{o.id !== operator?.id &&
                    <Button variant={o.active ? 'danger' : 'soft'} onClick={() => toggleActive(o)}>
                      {o.active ? 'Deactivate' : 'Activate'}
                    </Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <Modal title="Add platform account" onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            <Field label="Name"><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required autoFocus /></Field>
            <Field label="Email"><Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /></Field>
            <Field label="Password" hint="At least 10 characters."><Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required /></Field>
            <Field label="Role">
              <Select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                <option value="operator">Operator — gateways, workspaces, messages</option>
                <option value="owner">Owner — everything incl. apps, keys, releases</option>
              </Select>
            </Field>
            <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
