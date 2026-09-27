import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, Card, Empty, PageHead, Stat, timeAgo } from '../components/ui';

type Job = { request_id: string; recipient: string; status: string; remote_name?: string; created_at: string; reason?: string };
type Dash = {
  identity: { application_id: string; connect_endpoint: string };
  counts: { pending: number; processing: number; success: number; failed: number };
  android_online: number;
  products_connected: number;
  connections: Array<{ display_name: string; remote_kind: string; connected: boolean; online?: boolean; remote_application_name: string }>;
  jobs: Job[];
  requests: unknown[];
};

export default function Dashboard() {
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setData(await api.get<Dash>('control/connect')); setError(''); }
    catch (e: any) { setError(e?.message || 'Failed to load dashboard.'); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  if (error && !data) return <Card title="Dashboard"><div className="form-error">{error}</div></Card>;
  if (!data) return <div className="center-screen">Loading…</div>;
  const moving = data.counts.pending + data.counts.processing;

  return (
    <>
      <PageHead
        title="Dashboard"
        subtitle="One connection to each product. ConnectX owns the Android phone and the SIM. Results travel back the same path."
        actions={<button className="btn btn-ghost btn-sm" onClick={load}>Refresh</button>}
      />
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Products connected" value={data.products_connected} tone={data.products_connected ? 'good' : 'warn'} hint={data.identity.application_id} />
        <Stat label="Phones online" value={data.android_online} tone={data.android_online ? 'good' : 'warn'} hint="Android Phones page" />
        <Stat label="SMS moving" value={moving} tone="info" hint={`${data.counts.pending} pending · ${data.counts.processing} processing`} />
        <Stat label="SMS failed" value={data.counts.failed} tone={data.counts.failed ? 'bad' : 'default'} hint={`${data.counts.success} succeeded`} />
      </div>
      <div className="grid grid-2">
        <Card title="Connections" actions={<Link className="btn btn-ghost btn-sm" to="/connect">Open Connect App</Link>}>
          {data.connections.filter(c => c.connected).length === 0
            ? <Empty>Nothing is connected. <Link to="/connect">Connect App</Link> is where a product connects. Phones are listed under Android Phones.</Empty>
            : <div className="table-wrap"><table className="table"><thead><tr><th>Name</th><th>Kind</th><th>State</th></tr></thead><tbody>
              {data.connections.filter(c => c.connected).map((c, i) => (
                <tr key={i}><td className="td-main">{c.display_name || c.remote_application_name}</td><td>{c.remote_kind}</td><td>{c.remote_kind === 'android' && c.online ? <Badge value="Online" tone="good" /> : <Badge value="Connected" tone="good" />}</td></tr>
              ))}
            </tbody></table></div>}
        </Card>
        <Card title="How a message moves">
          <ol className="muted" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8 }}>
            <li>EMS asks its Connect Server to send SMS-10001.</li>
            <li>ConnectX checks the connection and keeps the job if the phone is offline.</li>
            <li>The Android app sends it on the SIM the user selected.</li>
            <li>SUCCESS or FAILED returns to EMS on the same Request ID.</li>
          </ol>
        </Card>
      </div>
      <Card title="Recent SMS" actions={<Link className="btn btn-ghost btn-sm" to="/jobs">All messages</Link>}>
        {data.jobs.length === 0 ? <Empty>No SMS yet. They appear after a connected product sends one.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Request</th><th>To</th><th>From</th><th>Status</th><th>When</th></tr></thead>
            <tbody>{data.jobs.slice(0, 8).map(j => (
              <tr key={j.request_id + j.created_at}>
                <td className="mono">{j.request_id}</td>
                <td>{j.recipient}</td>
                <td>{j.remote_name || '—'}</td>
                <td><Badge value={j.status} tone={j.status === 'SUCCESS' ? 'good' : j.status === 'FAILED' ? 'bad' : j.status === 'PROCESSING' ? 'info' : 'warn'} /></td>
                <td>{timeAgo(j.created_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
