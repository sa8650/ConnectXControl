import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Client, Workspace } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import {
  Badge, Button, Card, CopyButton, Empty, Field, Input, Modal, PageHead,
  Select, Spinner, TextArea, fmtDate, timeAgo, toast
} from '../components/ui';

export default function Clients() {
  const { operator } = useAuth();
  const isOwner = operator?.role === 'owner';
  const [clients, setClients] = useState<Client[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState('');
  const [newKeyFor, setNewKeyFor] = useState<Client | null>(null);
  const [issuedKey, setIssuedKey] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [webhookFor, setWebhookFor] = useState<Client | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, w] = await Promise.all([api.get<Client[]>('control/clients'), api.get<Workspace[]>('control/workspaces')]);
      setClients(c); setWorkspaces(w); setError('');
    } catch (e: any) { setError(e?.message || 'Failed to load apps.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function revokeKey(client: Client, keyId: string, prefix: string) {
    if (!confirm(`Revoke API key ${prefix}… for ${client.name}? Integrations using it stop immediately.`)) return;
    try {
      await api.post(`control/keys/${encodeURIComponent(keyId)}/revoke`);
      toast('API key revoked'); load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  if (error) return <Card title="Apps"><div className="form-error">{error}</div></Card>;
  if (!clients) return <div className="center-screen"><Spinner /></div>;

  return (
    <>
      <PageHead
        title="Connected Apps & API Keys"
        subtitle="Every product that pushes messages through ConnectX — EMS, CareOS, InfluenceOS, PlugX or anything you add. Apps authenticate with API keys, never with device or owner credentials."
        actions={isOwner ? <Button onClick={() => setAddOpen(true)}>＋ Add app</Button> : undefined}
      />

      {!isOwner && <div className="form-note">You are signed in as an operator. Only the platform owner can issue or revoke API keys.</div>}

      {clients.length === 0 ? <Card><Empty>No apps registered yet.</Empty></Card> : clients.map(c => (
        <Card key={c.id}
          title={<span>{c.name} <span className="mono muted">({c.client_key})</span> <Badge value={c.status} /></span>}
          subtitle={c.description || undefined}
          actions={
            <>
              <Button variant="ghost" onClick={() => setWebhookFor(c)}>Webhook</Button>
              {isOwner && <Button variant="soft" onClick={() => { setNewKeyFor(c); setIssuedKey(''); }}>＋ Issue API key</Button>}
            </>
          }>
          <div className="pill-row" style={{ marginBottom: 12 }}>
            <span className="pill">30 days: {c.usage30d?.sent ?? 0} sent</span>
            <span className="pill">{c.usage30d?.failed ?? 0} failed</span>
            <span className="pill">{c.usage30d?.pending ?? 0} pending</span>
            {c.webhook_url && <span className="pill">webhook: {c.webhook_url.replace(/^https?:\/\//, '').slice(0, 40)}</span>}
          </div>
          {(c.keys || []).length === 0
            ? <p className="muted" style={{ margin: 0 }}>No API keys yet — this app cannot call ConnectX until one is issued.</p>
            : <div className="table-wrap"><table className="table">
                <thead><tr><th>Label</th><th>Key</th><th>Workspace scope</th><th>Daily limit</th><th>Status</th><th>Last used</th><th></th></tr></thead>
                <tbody>
                  {(c.keys || []).map(k => (
                    <tr key={k.id}>
                      <td className="td-main">{k.label}</td>
                      <td className="mono">{k.key_prefix}…••••</td>
                      <td>{k.workspace ? `${k.workspace.name} (${k.workspace.code})` : <span className="td-sub">all workspaces</span>}</td>
                      <td>{k.daily_limit === 0 ? 'unlimited' : `${k.daily_limit}/day`}</td>
                      <td><Badge value={k.status} /></td>
                      <td className="td-sub" title={fmtDate(k.last_used_at)}>{timeAgo(k.last_used_at)}</td>
                      <td>{isOwner && k.status === 'active' &&
                        <Button variant="danger" onClick={() => revokeKey(c, k.id, k.key_prefix)}>Revoke</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>}
        </Card>
      ))}

      <Card title="How apps integrate">
        <p className="muted" style={{ marginTop: 0 }}>
          Apps call the ConnectX Client API with their key in the <span className="mono">X-ConnectX-Key</span> header —
          push SMS jobs, log email history, query status, and receive webhook callbacks. Full reference with copy-paste
          examples: <Link to="/api-docs">API Docs</Link>.
        </p>
      </Card>

      {newKeyFor && (
        <Modal title={`Issue API key — ${newKeyFor.name}`} onClose={() => setNewKeyFor(null)}>
          {!issuedKey ? <NewKeyForm client={newKeyFor} workspaces={workspaces}
              onIssued={key => { setIssuedKey(key); load(); }} />
            : <div>
                <div className="form-note">
                  This is the only time the full key is shown. Copy it now into the app's ConnectX settings.
                </div>
                <pre className="code">{issuedKey}</pre>
                <div className="pill-row"><CopyButton value={issuedKey} label="Copy API key" /></div>
                <div style={{ marginTop: 14 }}><Button variant="ghost" onClick={() => setNewKeyFor(null)}>Done</Button></div>
              </div>}
        </Modal>
      )}

      {addOpen && <AddClient onClose={() => setAddOpen(false)} onAdded={() => { setAddOpen(false); load(); }} />}
      {webhookFor && <WebhookForm client={webhookFor} onClose={() => setWebhookFor(null)} onSaved={() => { setWebhookFor(null); load(); }} />}
    </>
  );
}

function NewKeyForm({ client, workspaces, onIssued }: { client: Client; workspaces: Workspace[]; onIssued: (key: string) => void }) {
  const [label, setLabel] = useState(`${client.name} production`);
  const [ws, setWs] = useState('');
  const [limit, setLimit] = useState('1000');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ api_key: string }>(`control/clients/${encodeURIComponent(client.id)}/keys`, {
        label, workspace_id: ws || null, daily_limit: Number(limit)
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
      <Field label="Workspace scope" hint="Restrict this key to one workspace, or allow all.">
        <Select value={ws} onChange={e => setWs(e.target.value)}>
          <option value="">All workspaces</option>
          {workspaces.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
        </Select>
      </Field>
      <Field label="Daily message limit" hint="0 = unlimited. Counts SMS + email jobs created per day.">
        <Input type="number" min={0} value={limit} onChange={e => setLimit(e.target.value)} required />
      </Field>
      <Button type="submit" disabled={busy}>{busy ? 'Issuing…' : 'Issue key'}</Button>
    </form>
  );
}

function AddClient({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ name: '', client_key: '', description: '' });
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('control/clients', form);
      toast('App added — now issue it an API key');
      onAdded();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Add connected app" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="App name">
          <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="CareOS" required autoFocus />
        </Field>
        <Field label="client_key" hint="Lowercase slug used in API payloads (a-z, 0-9, _).">
          <Input value={form.client_key} onChange={e => setForm({ ...form, client_key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} placeholder="careos" required />
        </Field>
        <Field label="Description">
          <TextArea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="What this product uses ConnectX for." />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add app'}</Button>
      </form>
    </Modal>
  );
}

function WebhookForm({ client, onClose, onSaved }: { client: Client; onClose: () => void; onSaved: () => void }) {
  const [url, setUrl] = useState(client.webhook_url || '');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch(`control/clients/${encodeURIComponent(client.id)}`, { webhook_url: url });
      toast('Webhook saved'); onSaved();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`Webhook — ${client.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-note">
          ConnectX POSTs <span className="mono">job.sent</span>, <span className="mono">job.failed</span> and{' '}
          <span className="mono">job.cancelled</span> events for this app's jobs. HTTPS only; signed with{' '}
          <span className="mono">x-connectx-signature</span> when WEBHOOK_SIGNING_SECRET is set.
        </div>
        <Field label="Webhook URL" hint="Leave empty to disable.">
          <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-app.example.com/hooks/connectx" />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save webhook'}</Button>
      </form>
    </Modal>
  );
}
