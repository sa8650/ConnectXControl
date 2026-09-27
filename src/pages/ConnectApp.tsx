import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Button, Card, Empty, Field, Input, PageHead, toast } from '../components/ui';

type Identity = {
  application_id: string; application_name: string; connect_endpoint: string; kind: string;
};
type Conn = {
  connection_id: string; remote_application_id: string; remote_application_name: string;
  remote_endpoint: string; remote_kind: string; display_name: string;
  permissions: string[]; status: string; connected: boolean;
};
type Req = {
  request_token: string; pairing_code: string; remote_application_name: string;
  remote_application_id: string; remote_kind: string; display_name: string;
  requested_permissions: string[]; status: string; direction?: string;
};
type Overview = {
  ready: boolean; error?: string; identity: Identity; endpoint_override: string;
  connections: Conn[]; requests: Req[];
  counts: { pending: number; processing: number; success: number; failed: number };
  products_connected: number;
};

function Connected({ on }: { on: boolean }) {
  return on
    ? <span className="badge badge-good"><i className="live-dot" /> Connected</span>
    : <Badge value="Not connected" tone="muted" />;
}

export default function ConnectApp() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [displayName, setDisplayName] = useState('ConnectX');
  const [override, setOverride] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await api.get<Overview>('control/connect');
      setData(next);
      setOverride(next.endpoint_override || '');
      setError('');
    } catch (e: any) { setError(e?.message || 'Could not load Connect App.'); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast(ok); await load(); }
    catch (e: any) { toast(e?.message || 'Failed', 'err'); }
    finally { setBusy(''); }
  }

  if (error && !data) return <Card title="Connect App"><div className="form-error">{error}</div></Card>;
  if (!data) return <div className="center-screen">Loading Connect App…</div>;

  const products = data.connections.filter(c => c.remote_kind !== 'android');
  const waiting = data.requests.filter(r => r.status === 'PENDING_APPROVAL' && r.direction !== 'outbound');

  return (
    <>
      <PageHead
        title="Connect App"
        subtitle="Connect a product once. Both sides then show Connected. The phone is not set up here."
        actions={<Button variant="ghost" onClick={load}>Refresh</Button>}
      />

      <Card title="This ConnectX" actions={<Connected on={data.products_connected > 0} />}>
        <div className="kv">
          <div><span>Application ID</span><b className="mono">{data.identity.application_id}</b></div>
          <div><span>Connect Endpoint</span><b className="mono">{data.identity.connect_endpoint}</b></div>
        </div>
        <div className="page-actions" style={{ marginTop: 12 }}>
          <Button variant="soft" onClick={() => navigator.clipboard.writeText(data.identity.connect_endpoint).then(() => toast('Endpoint copied'))}>Copy endpoint</Button>
        </div>
        <form style={{ marginTop: 14 }} onSubmit={e => { e.preventDefault(); run('endpoint', () => api.post('control/connect/endpoint', { endpoint: override }), 'Endpoint saved'); }}>
          <Field label="Public URL override" hint="Leave blank unless this site is reached on a different address.">
            <Input value={override} onChange={e => setOverride(e.target.value)} placeholder="https://connectxweb.pages.dev/connect" />
          </Field>
          <Button type="submit" variant="ghost" disabled={busy === 'endpoint'}>Save override</Button>
        </form>
      </Card>

      {waiting.length > 0 && (
        <Card title="Requests to approve">
          {waiting.map(r => (
            <div className="wait-card" key={r.request_token}>
              <div>
                <strong>{r.display_name || r.remote_application_name}</strong>
                <div className="muted">{r.remote_application_name} · {r.remote_application_id}</div>
                <div style={{ marginTop: 8 }}><span className="pair-code">{r.pairing_code}</span></div>
              </div>
              <div className="page-actions">
                <Button disabled={busy === r.request_token} onClick={() => run(r.request_token, () => api.post(`control/connect/requests/${encodeURIComponent(r.request_token)}/approve`), 'Connected')}>Approve</Button>
                <Button variant="ghost" onClick={() => run('reject-' + r.request_token, () => api.post(`control/connect/requests/${encodeURIComponent(r.request_token)}/reject`), 'Rejected')}>Reject</Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card title="Connected products" subtitle="Active sends SMS. Pause holds new SMS. Disconnect or delete stops the link.">
        {products.length === 0 ? <Empty>No product is connected yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Status</th><th>App</th><th>Connection ID</th><th></th></tr></thead>
            <tbody>{products.map(c => (
              <tr key={c.connection_id}>
                <td>{c.status === 'ACTIVE' ? <Connected on /> : <Badge value={c.status === 'PAUSED' ? 'Paused' : c.status} tone={c.status === 'PAUSED' ? 'warn' : 'muted'} />}</td>
                <td className="td-main">{c.display_name || c.remote_application_name}<div className="muted mono">{c.remote_application_id}</div></td>
                <td className="mono">{c.connection_id}</td>
                <td>
                  <select
                    className="input"
                    value={['ACTIVE', 'PAUSED', 'DISCONNECTED'].includes(c.status) ? c.status : 'DISCONNECTED'}
                    disabled={busy === c.connection_id}
                    onChange={e => {
                      const status = e.target.value;
                      if ((status === 'DISCONNECTED' || status === 'DELETED') && !confirm(status === 'DELETED' ? 'Delete this connected app?' : 'Disconnect this app? SMS stays pending until it is active again.')) {
                        load();
                        return;
                      }
                      run(c.connection_id, () => api.post(`control/connect/connections/${encodeURIComponent(c.connection_id)}/status`, { status }), status === 'DELETED' ? 'Deleted' : 'Updated');
                    }}
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="PAUSED">Pause</option>
                    <option value="DISCONNECTED">Disconnect</option>
                    <option value="DELETED">Delete</option>
                  </select>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <Card title="Connect out" subtitle="Optional. Usually the other app sends the request and you approve it above.">
        <form onSubmit={e => { e.preventDefault(); run('request', () => api.post('control/connect/request', { remote_endpoint: endpoint, display_name: displayName }), 'Request sent. Approve it on the other app.'); }}>
          <Field label="Their Connect Endpoint">
            <Input required value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://ems.example.com/connect" />
          </Field>
          <Field label="Name they will see">
            <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy === 'request'}>Send connection request</Button>
        </form>
      </Card>
    </>
  );
}
