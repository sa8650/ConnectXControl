import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, SystemInfo } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import {
  Badge, Button, Card, CopyButton, Empty, Field, Input, Modal, PageHead,
  Spinner, TextArea, fmtDate, timeAgo, toast
} from '../components/ui';

export default function Systems() {
  const { operator } = useAuth();
  const isOwner = operator?.role === 'owner';
  const [systems, setSystems] = useState<SystemInfo[] | null>(null);
  const [error, setError] = useState('');
  const [newKeyFor, setNewKeyFor] = useState<SystemInfo | null>(null);
  const [issuedKey, setIssuedKey] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editFor, setEditFor] = useState<SystemInfo | null>(null);

  const load = useCallback(async () => {
    try {
      setSystems(await api.get<SystemInfo[]>('control/systems'));
      setError('');
    } catch (e: any) { setError(e?.message || 'Failed to load systems.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function revokeKey(system: SystemInfo, keyId: string, prefix: string) {
    if (!confirm(`Revoke API key ${prefix}… for ${system.name}? Integrations using it stop immediately.`)) return;
    try {
      await api.post(`control/keys/${encodeURIComponent(keyId)}/revoke`);
      toast('API key revoked'); load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  if (error) return <Card title="Systems"><div className="form-error">{error}</div></Card>;
  if (!systems) return <div className="center-screen"><Spinner /></div>;

  return (
    <>
      <PageHead
        title="Connected Systems & API Keys"
        subtitle="Every product integrated with ConnectX — EMS, CareOS, InfluenceOS, PlugX or anything you add. The ConnectX phone app signs administrators in through the system API URL you configure here; systems push messages with API keys."
        actions={isOwner ? <Button onClick={() => setAddOpen(true)}>＋ Add system</Button> : undefined}
      />

      {!isOwner && <div className="form-note">You are signed in as an operator. Only the platform owner can configure systems or issue API keys.</div>}

      {systems.length === 0 ? <Card><Empty>No systems registered yet.</Empty></Card> : systems.map(s => (
        <Card key={s.id}
          title={<span>{s.name} <span className="mono muted">({s.system_key})</span> <Badge value={s.status} />{' '}
            <Badge value={s.configured ? 'connected' : 'not configured'} /></span>}
          subtitle={s.description || undefined}
          actions={
            <>
              {isOwner && <Button variant="ghost" onClick={() => setEditFor(s)}>Configure</Button>}
              {isOwner && <Button variant="soft" onClick={() => { setNewKeyFor(s); setIssuedKey(''); }}>＋ Issue API key</Button>}
            </>
          }>
          <div className="pill-row" style={{ marginBottom: 12 }}>
            <span className="pill">shops: {s.shops}</span>
            <span className="pill">gateways: {s.devices}</span>
            <span className="pill">30 days: {s.usage30d?.sent ?? 0} sent</span>
            <span className="pill">{s.usage30d?.failed ?? 0} failed</span>
            <span className="pill">{s.usage30d?.pending ?? 0} pending</span>
            {s.api_url
              ? <span className="pill mono">api: {s.api_url.replace(/^https?:\/\//, '').slice(0, 44)}</span>
              : <span className="pill">api: not configured — phone sign-in disabled</span>}
            {s.webhook_url && <span className="pill">webhook: {s.webhook_url.replace(/^https?:\/\//, '').slice(0, 40)}</span>}
          </div>
          {(s.keys || []).length === 0
            ? <p className="muted" style={{ margin: 0 }}>No API keys yet — this system cannot call ConnectX until one is issued.</p>
            : <div className="table-wrap"><table className="table">
                <thead><tr><th>Label</th><th>Key</th><th>Daily limit</th><th>Status</th><th>Last used</th><th></th></tr></thead>
                <tbody>
                  {(s.keys || []).map(k => (
                    <tr key={k.id}>
                      <td className="td-main">{k.label}</td>
                      <td className="mono">{k.key_prefix}…••••</td>
                      <td>{k.daily_limit === 0 ? 'unlimited' : `${k.daily_limit}/day`}</td>
                      <td><Badge value={k.status} /></td>
                      <td className="td-sub" title={fmtDate(k.last_used_at)}>{timeAgo(k.last_used_at)}</td>
                      <td>{isOwner && k.status === 'active' &&
                        <Button variant="danger" onClick={() => revokeKey(s, k.id, k.key_prefix)}>Revoke</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>}
        </Card>
      ))}

      <Card title="How systems integrate">
        <p className="muted" style={{ marginTop: 0 }}>
          Two channels, both configured here: (1) the <strong>phone app</strong> sends administrator logins to the
          system's API URL — credentials never live on the phone; (2) the <strong>system backend</strong> calls the
          ConnectX Client API with its key in the <span className="mono">X-ConnectX-Key</span> header and a{' '}
          <span className="mono">shop</span> reference on every message. Delivery results are pushed back to the
          system's webhook. Full reference: <Link to="/api-docs">API Docs</Link>.
        </p>
      </Card>

      {newKeyFor && (
        <Modal title={`Issue API key — ${newKeyFor.name}`} onClose={() => setNewKeyFor(null)}>
          {!issuedKey ? <NewKeyForm system={newKeyFor}
              onIssued={key => { setIssuedKey(key); load(); }} />
            : <div>
                <div className="form-note">
                  This is the only time the full key is shown. Copy it now into the system's ConnectX settings.
                </div>
                <pre className="code">{issuedKey}</pre>
                <div className="pill-row"><CopyButton value={issuedKey} label="Copy API key" /></div>
                <div style={{ marginTop: 14 }}><Button variant="ghost" onClick={() => setNewKeyFor(null)}>Done</Button></div>
              </div>}
        </Modal>
      )}

      {addOpen && <AddSystem onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); load(); }} />}
      {editFor && <ConfigureSystem system={editFor} onClose={() => setEditFor(null)}
        onSaved={() => { setEditFor(null); load(); }} onChanged={load} />}
    </>
  );
}

function NewKeyForm({ system, onIssued }: { system: SystemInfo; onIssued: (key: string) => void }) {
  const [label, setLabel] = useState(`${system.name} production`);
  const [limit, setLimit] = useState('1000');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ api_key: string }>(`control/systems/${encodeURIComponent(system.id)}/keys`, {
        label, daily_limit: Number(limit)
      });
      onIssued(res.api_key);
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit}>
      <Field label="Key label">
        <Input value={label} onChange={e => setLabel(e.target.value)} required />
      </Field>
      <Field label="Daily message limit" hint="0 = unlimited. Counts SMS + email jobs created per day across all shops of this system.">
        <Input type="number" min={0} value={limit} onChange={e => setLimit(e.target.value)} required />
      </Field>
      <Button type="submit" disabled={busy}>{busy ? 'Issuing…' : 'Issue key'}</Button>
    </form>
  );
}

function AddSystem({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ name: '', system_key: '', description: '', api_url: '' });
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('control/systems', form);
      toast('System added — configure its API URL and issue an API key');
      onAdded();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Add connected system" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="System name">
          <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="CareOS" required autoFocus />
        </Field>
        <Field label="system_key" hint="Lowercase slug used in API payloads (a-z, 0-9, _).">
          <Input value={form.system_key} onChange={e => setForm({ ...form, system_key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} placeholder="careos" required />
        </Field>
        <Field label="API URL" hint="Base URL of the system. Used for phone-app administrator sign-in. Can be set later.">
          <Input value={form.api_url} onChange={e => setForm({ ...form, api_url: e.target.value })} placeholder="https://api.careos.example" />
        </Field>
        <Field label="Description">
          <TextArea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="What this product uses ConnectX for." />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add system'}</Button>
      </form>
    </Modal>
  );
}

function ConfigureSystem({ system, onClose, onSaved, onChanged }: {
  system: SystemInfo; onClose: () => void; onSaved: () => void; onChanged: () => void;
}) {
  const [form, setForm] = useState({
    name: system.name, description: system.description || '', api_url: system.api_url || '',
    login_path: system.login_path || '', shops_path: system.shops_path || '',
    webhook_url: system.webhook_url || ''
  });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`control/systems/${encodeURIComponent(system.id)}`, form);
      toast('System configuration saved');
      onSaved();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  async function toggleStatus() {
    const next = system.status === 'active' ? 'disabled' : 'active';
    try {
      await api.patch(`control/systems/${encodeURIComponent(system.id)}`, { status: next });
      toast(`System ${next === 'disabled' ? 'disabled' : 'enabled'}`);
      onChanged(); onClose();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  async function remove() {
    if (!confirm(`Delete ${system.name}? Only possible while it has no message history or paired devices.`)) return;
    try {
      await api.del(`control/systems/${encodeURIComponent(system.id)}`);
      toast('System deleted'); onChanged(); onClose();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  return (
    <Modal title={`Configure — ${system.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Name">
            <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <Field label="Description">
            <Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
        <Field label="API URL" hint="Base URL of the system's API. The ConnectX phone app signs administrators in through ConnectX — the phone never talks to the system directly.">
          <Input value={form.api_url} onChange={e => setForm({ ...form, api_url: e.target.value })} placeholder="https://api.example.com" />
        </Field>
        <div className="form-row">
          <Field label="Admin login path" hint="POST {email,password} → {token,user}.">
            <Input value={form.login_path} onChange={e => setForm({ ...form, login_path: e.target.value })} placeholder="api/auth/admin/login" />
          </Field>
          <Field label="Shops path" hint="GET with Bearer token → {shops:[…]}.">
            <Input value={form.shops_path} onChange={e => setForm({ ...form, shops_path: e.target.value })} placeholder="api/connectx/gateway/shops" />
          </Field>
        </div>
        <Field label="Webhook URL" hint="Delivery reports (job.sent / job.failed / job.cancelled) are POSTed here. HTTPS only; signed with x-connectx-signature. Empty = disabled.">
          <Input value={form.webhook_url} onChange={e => setForm({ ...form, webhook_url: e.target.value })} placeholder="https://api.example.com/hooks/connectx" />
        </Field>
        <div className="pill-row" style={{ marginTop: 14 }}>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save configuration'}</Button>
          <Button variant={system.status === 'active' ? 'danger' : 'soft'} onClick={toggleStatus}>
            {system.status === 'active' ? 'Disable system' : 'Enable system'}
          </Button>
          <Button variant="ghost" onClick={remove}>Delete…</Button>
        </div>
      </form>
    </Modal>
  );
}
