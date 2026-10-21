import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { MonitorOverview, MonitorRange } from '../api/monitor';
import { Badge, Button, Card, Empty, PageHead, Select, Spinner, Stat, fmtDate } from '../components/ui';

const RANGES: Array<{ value: MonitorRange; label: string }> = [
  { value: '24h', label: 'Last 24 hours' }, { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' }, { value: 'all', label: 'All time' }
];

export default function Dashboard() {
  const [range, setRange] = useState<MonitorRange>('24h');
  const [data, setData] = useState<MonitorOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const snapshot = await api.get<MonitorOverview>(`control/dashboard?range=${range}`);
      setData(snapshot); setError('');
    } catch (e: any) { setError(e?.message || 'Could not load locally stored ConnectX monitoring data.'); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!data && loading) return <div className="center-screen"><Spinner /></div>;
  if (!data) return <><PageHead title="Dashboard" subtitle="ConnectX app monitoring stored in the Control database." /><Card title="No monitoring data available"><div className="form-error">{error || 'No app events have been received yet.'}</div><p className="muted">Android device records sync automatically when ConnectX Android registers with EMS and posts its registration details to this website.</p><Link className="btn btn-soft btn-sm" to="/phones">Open Android devices</Link><Button onClick={() => { void load(); }}>Retry</Button></Card></>;

  const s = data.sms; const d = data.devices;
  return <>
    <PageHead title="Dashboard" subtitle="App usage and SMS outcomes recorded in ConnectX Control. SMS queueing and delivery continue through EMS and the app." actions={<><Select aria-label="Reporting period" value={range} onChange={e => setRange(e.target.value as MonitorRange)}>{RANGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select><Button variant="soft" onClick={() => { void load(); }}>Refresh</Button><Link className="btn btn-ghost btn-sm" to="/jobs">SMS history</Link></>} />
    {error && <div className="form-error" role="status">Showing the last saved snapshot. {error}</div>}
    <div className="monitor-meta muted">SMS period: <strong>{RANGES.find(item => item.value === data.range)?.label || data.range}</strong> · Unique active users use a rolling 30-day window · Snapshot {fmtDate(data.generatedAt)}</div>
    <div className="grid grid-4 monitor-stat-grid">
      <Stat label="Active app users" value={data.users.active} tone={data.users.active ? 'good' : 'default'} hint={`${data.users.registered} distinct accounts linked`} />
      <Stat label="Registered devices" value={d.registered} hint={`${d.online} online · ${d.offline} offline`} />
      <Stat label="SMS records" value={s.total} hint="Unique EMS job IDs stored in Control" />
      <Stat label="Delivered" value={s.delivered} tone="good" hint="Carrier-confirmed delivery receipts" />
      <Stat label="Unsuccessful" value={s.unsuccessful} tone={s.unsuccessful ? 'bad' : 'good'} hint="SMS send failures reported by the app" />
      <Stat label="Send accepted" value={s.sent} tone="info" hint="Accepted for send; not necessarily delivered" />
      <Stat label="Unknown outcome" value={s.unknown} tone={s.unknown ? 'warn' : 'default'} hint="Send completion could not be confirmed" />
      <Stat label="Processing" value={s.processing} tone={s.processing ? 'warn' : 'default'} hint="Currently being handled by a connected app" />
    </div>
    <div className="grid grid-2 monitor-detail-grid">
      <Card title="Most recently active app" subtitle="Device version and last heartbeat stored by Control">
        {data.mostRecentlySeen ? <div className="monitor-device-summary"><div className="monitor-summary-heading"><div><strong>{data.mostRecentlySeen.deviceName}</strong><div className="td-sub">{data.mostRecentlySeen.shopName} · {data.mostRecentlySeen.administratorName}</div></div><Badge value={data.mostRecentlySeen.online ? 'online' : 'offline'} /></div><div className="monitor-summary-grid"><div><span>App version / build</span><strong>{data.mostRecentlySeen.appVersion} · {data.mostRecentlySeen.versionCode}</strong></div><div><span>Android</span><strong>{data.mostRecentlySeen.androidVersion}</strong></div><div><span>Last seen</span><strong>{fmtDate(data.mostRecentlySeen.lastSeen)}</strong></div><div><span>Registered installs</span><strong>{d.registered}</strong></div></div><Link className="btn btn-ghost btn-sm" to="/phones">Manage devices and versions</Link></div> : <Empty>No device heartbeat has arrived yet.</Empty>}
      </Card>
      <Card title="Latest unsuccessful or uncertain SMS" subtitle="Stored in the Control database; message bodies are never copied.">
        {s.recentErrors.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Shop</th><th>Recipient</th><th>Status</th></tr></thead><tbody>{s.recentErrors.slice(0, 6).map(row => <tr key={row.id}><td className="td-sub">{fmtDate(row.createdAt)}</td><td>{row.shopName}</td><td className="mono">{row.recipientPhone}</td><td><Badge value={row.status} /></td></tr>)}</tbody></table></div> : <Empty>No failed or uncertain messages in this period.</Empty>}
      </Card>
    </div>
  </>;
}
