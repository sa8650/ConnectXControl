import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { MonitorSms, MonitorSmsPage, MonitorRange, SmsState } from '../api/monitor';
import { Badge, Button, Card, Empty, PageHead, Select, Spinner, fmtDate } from '../components/ui';

const PAGE_SIZE = 50;
const RANGES: Array<{ value: MonitorRange; label: string }> = [
  { value: '24h', label: 'Last 24 hours' }, { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' }, { value: 'all', label: 'All time' }
];
const STATES = ['', 'processing', 'sent', 'delivered', 'failed', 'unknown', 'cancelled'];

function queryFor(range: MonitorRange, status: string, offset = 0) {
  const params = new URLSearchParams({ range, limit: String(PAGE_SIZE), offset: String(offset) });
  if (status) params.set('status', status);
  return params.toString();
}

export default function Jobs() {
  const [range, setRange] = useState<MonitorRange>('30d');
  const [status, setStatus] = useState('');
  const [data, setData] = useState<MonitorSmsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try { setData(await api.get<MonitorSmsPage>(`control/jobs?${queryFor(range, status)}`)); setError(''); }
    catch (e: any) { setError(e?.message || 'Could not load Control SMS history.'); }
    finally { setLoading(false); }
  }, [range, status]);
  useEffect(() => { void load(); const timer = window.setInterval(() => { void load(true); }, 60_000); return () => window.clearInterval(timer); }, [load]);

  async function loadMore() {
    if (!data?.hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.get<MonitorSmsPage>(`control/jobs?${queryFor(range, status, data.items.length)}`);
      setData(previous => previous ? { ...next, items: [...previous.items, ...next.items] } : next); setError('');
    } catch (e: any) { setError(e?.message || 'Could not load more SMS records.'); }
    finally { setLoadingMore(false); }
  }

  if (!data && loading) return <div className="center-screen"><Spinner /></div>;
  if (!data) return <><PageHead title="SMS history" subtitle="Delivery results copied from ConnectX Android into the Control database." /><Card title="History unavailable"><div className="form-error">{error || 'No SMS records are available.'}</div><Button onClick={() => { void load(); }}>Retry</Button></Card></>;

  return <>
    <PageHead title="SMS history" subtitle="Each app-reported result is stored in ConnectX Control. SMS dispatch and authoritative reporting to EMS remain unchanged." actions={<><Button variant="soft" onClick={() => { void load(); }}>Refresh</Button><Link className="btn btn-ghost btn-sm" to="/phones">App devices</Link></>} />
    {error && <div className="form-error" role="status">Refresh failed; showing the last saved page. {error}</div>}
    <div className="filters monitor-filters">
      <Select aria-label="History period" value={range} onChange={e => setRange(e.target.value as MonitorRange)}>{RANGES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select>
      <Select aria-label="Filter SMS state" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{STATES.filter(Boolean).map(item => <option key={item} value={item}>{item}</option>)}</Select>
      <span className="muted monitor-filter-summary">{data.total} matching records · newest first · Control database</span>
    </div>
    <Card title="SMS delivery records" subtitle={`${data.items.length} shown of ${data.total} · refreshed ${fmtDate(data.serverTime)}`}>
      {data.items.length === 0 ? <Empty>No records match the selected period and status.</Empty> : <div className="table-wrap"><table className="table monitor-history-table"><thead><tr><th>Created</th><th>Shop / app user</th><th>Recipient</th><th>Type</th><th>Status</th><th>App version</th><th>Sent at</th><th>Delivered at</th><th>Result / error</th></tr></thead><tbody>{data.items.map((row: MonitorSms) => <tr key={row.id}><td className="td-sub">{fmtDate(row.createdAt)}</td><td><div className="td-main">{row.shopName}</div><div className="td-sub">{row.administratorName || row.administratorCode || row.administratorId}</div></td><td><div className="td-main mono">{row.recipientPhone}</div><div className="td-sub">{row.recipientName}</div></td><td className="td-sub">{row.messageType}</td><td><Badge value={row.status as SmsState} /></td><td>{row.appVersion} · {row.versionCode}</td><td className="td-sub">{row.sentAt ? fmtDate(row.sentAt) : '—'}</td><td className="td-sub">{row.deliveredAt ? fmtDate(row.deliveredAt) : '—'}</td><td className="monitor-error-cell">{row.error || '—'}</td></tr>)}</tbody></table></div>}
      {data.hasMore && <div className="monitor-load-more"><Button variant="soft" disabled={loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? 'Loading…' : `Load more (${data.items.length} of ${data.total})`}</Button></div>}
    </Card>
    <div className="monitor-history-note"><p><strong>Sent</strong> is device/carrier acceptance, not delivery confirmation. <strong>Delivered</strong> requires a carrier delivery callback.</p><p>Full recipient numbers are stored in Control as requested. SMS message bodies are not copied. Uncertain sends remain separately labelled unknown.</p></div>
  </>;
}
