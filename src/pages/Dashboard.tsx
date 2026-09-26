import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Dashboard as Dash } from '../api/client';
import { Badge, Card, Empty, PageHead, Spinner, Stat, fmtDate, timeAgo } from '../components/ui';

export default function Dashboard() {
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const offset = -new Date().getTimezoneOffset();
      setData(await api.get<Dash>(`control/dashboard?utcOffsetMinutes=${offset}`));
      setError('');
    } catch (e: any) { setError(e?.message || 'Failed to load dashboard.'); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  if (error) return <Card title="Dashboard"><div className="form-error">{error}</div></Card>;
  if (!data) return <div className="center-screen"><Spinner /></div>;

  const clients = Object.entries(data.byClient);

  return (
    <>
      <PageHead
        title="Dashboard"
        subtitle="Live state of the ConnectX platform — gateways, message traffic and connected products."
        actions={<button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="SMS sent today" value={data.today.smsSent} tone="good" />
        <Stat label="SMS pending" value={data.today.smsPending} tone="info" hint="queued + sending" />
        <Stat label="SMS failed today" value={data.today.smsFailed} tone={data.today.smsFailed ? 'bad' : 'default'} />
        <Stat label="Emails logged today" value={data.today.emailSent} tone="default" hint={`${data.today.emailFailed} failed · ${data.today.emailPending} pending`} />
      </div>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Gateways online" value={`${data.devices.online}/${data.devices.total}`} tone={data.devices.online ? 'good' : 'warn'} hint="seen in last 3 minutes" />
        <Stat label="Pending test" value={data.devices.pendingTest} tone={data.devices.pendingTest ? 'warn' : 'default'} hint="awaiting first test SMS" />
        <Stat label="Workspaces" value={data.workspaces.total} hint={`${data.workspaces.active} active`} />
        <Stat label="Connected apps" value={data.clients.total} hint={`${data.clients.active} active`} />
      </div>

      <div className="grid grid-2">
        <Card title="Traffic by app" subtitle="Today, per connected product (client API keys)">
          {clients.length === 0
            ? <Empty>No app traffic yet. Issue an API key under <Link to="/clients">Apps &amp; API Keys</Link>.</Empty>
            : <div className="table-wrap"><table className="table">
                <thead><tr><th>App</th><th>Sent</th><th>Failed</th><th>Pending</th></tr></thead>
                <tbody>
                  {clients.map(([name, u]) => (
                    <tr key={name}>
                      <td className="td-main">{name}</td>
                      <td>{u.sent}</td>
                      <td>{u.failed}</td>
                      <td>{u.pending}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>}
        </Card>

        <Card title="Quick actions">
          <div className="pill-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
            <Link className="btn btn-soft" to="/devices">▣ Pair an Android gateway (generate pairing code)</Link>
            <Link className="btn btn-soft" to="/clients">⚿ Issue an API key for EMS / CareOS / InfluenceOS / PlugX</Link>
            <Link className="btn btn-soft" to="/releases">↥ Publish a ConnectX app release (updates channel)</Link>
            <Link className="btn btn-soft" to="/jobs">≡ Inspect or cancel queued messages</Link>
          </div>
        </Card>
      </div>

      <Card title="Recent messages" subtitle="Newest jobs across every app and gateway"
        actions={<Link className="btn btn-ghost btn-sm" to="/jobs">Open Messages →</Link>}>
        {data.recentJobs.length === 0
          ? <Empty>No messages yet. They appear here as apps push jobs through the ConnectX client API.</Empty>
          : <div className="table-wrap"><table className="table">
              <thead><tr><th>To</th><th>Type</th><th>App</th><th>Workspace</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {data.recentJobs.map(j => (
                  <tr key={j.id}>
                    <td>
                      <div className="td-main mono">{j.to || '—'}</div>
                      <div className="td-sub">{j.recipient_name || ''}</div>
                    </td>
                    <td>
                      <div className="td-main">{j.message_type || j.channel.toUpperCase()}</div>
                      <div className="td-sub">{j.channel}</div>
                    </td>
                    <td>{j.client_name}</td>
                    <td>{j.workspace_name || '—'}</td>
                    <td><Badge value={j.status} /></td>
                    <td className="td-sub" title={fmtDate(j.created_at)}>{timeAgo(j.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>}
      </Card>
    </>
  );
}
