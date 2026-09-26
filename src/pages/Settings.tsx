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
      <PageHead title="Settings" subtitle="Your account, the Android SMS gateway, email sending for connected apps, and platform accounts." />
      <div className="grid grid-2">
        <ProfileCard operator={operator!} onSaved={refresh} />
        <PasswordCard />
      </div>
      <SmsSettingsCard />
      {isOwner && <EmailCard />}
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
    <Card title="SMS gateway & templates (Android app)"
      subtitle="Per workspace: switch the Android SMS gateway on or off, and edit the templates rendered when an app sends a typed event (SALE, PAYMENT, …) without a message body.">
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

interface EmailCfg {
  provider: string;
  providers: Array<{ id: string; label: string; envKey: string; envKeySet: boolean }>;
  from_name: string; from_email: string; reply_to: string;
  enabled: boolean; daily_limit: number; mailgun_domain: string;
  api_key_set: boolean; key_source: 'environment' | 'database' | null;
}

function EmailCard() {
  const [cfg, setCfg] = useState<EmailCfg | null>(null);
  const [form, setForm] = useState({
    provider: 'brevo', api_key: '', from_name: '', from_email: '', reply_to: '',
    enabled: true, daily_limit: 0, mailgun_domain: ''
  });
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api.get<EmailCfg>('control/email');
      setCfg(c);
      setForm(f => ({
        ...f, provider: c.provider, from_name: c.from_name, from_email: c.from_email,
        reply_to: c.reply_to, enabled: c.enabled, daily_limit: c.daily_limit,
        mailgun_domain: c.mailgun_domain
      }));
    } catch { /* owner-only; card hidden otherwise */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const payload: any = { ...form, daily_limit: Number(form.daily_limit) || 0 };
      if (!payload.api_key.trim()) delete payload.api_key; // blank keeps the stored key
      await api.patch('control/email', payload);
      toast('Email settings saved');
      setForm(f => ({ ...f, api_key: '' }));
      load();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  async function sendTest(e: React.FormEvent) {
    e.preventDefault(); setTesting(true); setTestResult(null);
    try {
      const r = await api.post<{ ok: boolean; messageId?: string | null; mocked?: boolean }>('control/email/test', { to: testTo });
      setTestResult({ ok: true, text: `✓ Provider accepted the test email.${r.messageId ? ' Message ID: ' + r.messageId : ''}${r.mocked ? ' (mock mode — no real email sent)' : ''}` });
    } catch (err: any) { setTestResult({ ok: false, text: '✕ ' + (err?.message || 'Test failed') }); }
    finally { setTesting(false); }
  }

  const envSet = cfg?.providers.find(p => p.id === form.provider)?.envKeySet;
  const keyHint = envSet
    ? `${cfg?.providers.find(p => p.id === form.provider)?.envKey} is set as an environment secret and takes priority. Paste a key here only to store one in the database instead.`
    : cfg?.api_key_set
      ? 'A key is saved. Paste a new one to replace it — the saved value is never shown again.'
      : 'Brevo: dashboard → SMTP & API → API keys. The same key style works for the other providers.';

  return (
    <Card title="Email sending (provider)"
      subtitle="Connected apps send email through ConnectX with POST /api/client/v1/email/send — no app needs its own SMTP or Brevo setup. Sent mail appears in Messages here and on gateway phones.">
      {cfg === null ? <Empty>Loading…</Empty> : (
        <form onSubmit={save}>
          <div className="grid grid-2">
            <Field label="Provider">
              <Select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>
                {cfg.providers.map(p => (
                  <option key={p.id} value={p.id}>{p.label}{p.envKeySet ? ' — env secret detected' : ''}</option>
                ))}
              </Select>
            </Field>
            <Field label="API key" hint={keyHint}>
              <Input type="password" value={form.api_key} autoComplete="new-password"
                placeholder={cfg.api_key_set ? '••••••••••  (saved)' : 'Paste your provider API key'}
                onChange={e => setForm({ ...form, api_key: e.target.value })} />
            </Field>
            <Field label="From name"><Input value={form.from_name} placeholder="e.g. Main Workspace" onChange={e => setForm({ ...form, from_name: e.target.value })} /></Field>
            <Field label="From email" hint="Must be a sender allowed by your provider.">
              <Input type="email" value={form.from_email} placeholder="no-reply@yourdomain.com" onChange={e => setForm({ ...form, from_email: e.target.value })} />
            </Field>
            <Field label="Reply-To (optional)"><Input type="email" value={form.reply_to} placeholder="support@yourdomain.com" onChange={e => setForm({ ...form, reply_to: e.target.value })} /></Field>
            {form.provider === 'mailgun' && (
              <Field label="Mailgun sending domain"><Input value={form.mailgun_domain} placeholder="mg.yourdomain.com" onChange={e => setForm({ ...form, mailgun_domain: e.target.value })} /></Field>
            )}
            <Field label="Global daily email limit" hint="0 = unlimited. Applies to all apps together.">
              <Input type="number" min={0} value={form.daily_limit} onChange={e => setForm({ ...form, daily_limit: Number(e.target.value) })} />
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
            Email sending enabled
          </label>
          <p className="muted" style={{ fontSize: 12 }}>
            Providers are reached through their HTTP send APIs (Cloudflare Workers cannot open raw SMTP
            sockets). Keys created for SMTP in the same provider dashboard work here.
          </p>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save email settings'}</Button>
        </form>
      )}
      <form onSubmit={sendTest} style={{ marginTop: 16, borderTop: '1px solid var(--line, #e5e7eb)', paddingTop: 14 }}>
        <Field label="Test the connection" hint="Sends one diagnostic email through the saved settings.">
          <div style={{ display: 'flex', gap: 8 }}>
            <Input type="email" value={testTo} placeholder="you@yourdomain.com" required
              onChange={e => setTestTo(e.target.value)} />
            <Button type="submit" variant="soft" disabled={testing || !testTo}>{testing ? 'Sending…' : 'Send test'}</Button>
          </div>
        </Field>
        {testResult && (
          <p style={{ color: testResult.ok ? '#15803d' : '#b91c1c', fontSize: 13, marginTop: 6 }}>{testResult.text}</p>
        )}
      </form>
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
