import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { MonitorDevice, MonitorDevicesPage } from '../api/monitor';
import { Badge, Button, Card, Empty, PageHead, Select, Spinner, fmtDate } from '../components/ui';

const PAGE_SIZE = 50;

export default function Phones() {
  const [data, setData] = useState<MonitorDevicesPage | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status) params.set('status', status);
      setData(await api.get<MonitorDevicesPage>(`control/devices?${params}`));
      setError('');
    } catch (e: any) {
      setError(e?.message || 'Could not load registered Android devices.');
    } finally {
      setLoading(false);
    }
  }, [status, offset]);

  useEffect(() => { void load(); }, [load]);

  async function changeAccess(device: MonitorDevice) {
    const restoring = device.status === 'revoked';
    const action = restoring ? 'restore' : 'revoke';
    const prompt = restoring
      ? `Restore Control monitoring for ${device.deviceName}?`
      : `Revoke Control monitoring for ${device.deviceName}? This does not disconnect it from EMS.`;
    if (!window.confirm(prompt)) return;
    try {
      await api.post(`control/monitor/devices/${encodeURIComponent(device.id)}/${action}`);
      await load();
    } catch (e: any) {
      setError(e?.message || `Could not ${action} this device.`);
    }
  }

  const deviceStatus = (device: MonitorDevice) => {
    if (device.status === 'revoked') return 'revoked';
    if (device.deviceStatus === 'pending_test') return 'setup needed';
    return device.online ? 'online' : 'offline';
  };

  return <>
    <PageHead
      title="Android devices"
      subtitle="Registered Android device details are synced directly from ConnectX Android to this website. SMS delivery remains direct to EMS."
      actions={<Button variant="soft" onClick={() => { void load(); }}>Refresh</Button>}
    />
    <div className="filters monitor-filters">
      <Select aria-label="Filter Android devices" value={status} onChange={e => { setOffset(0); setStatus(e.target.value); }}>
        <option value="">All devices</option><option value="active">Active</option><option value="offline">Offline</option><option value="revoked">Revoked</option>
      </Select>
      <span className="muted monitor-filter-summary">{data?.online || 0} online · {data?.total || 0} registered devices</span>
    </div>
    <Card title="Registered Android devices" subtitle={data ? `Control database · ${fmtDate(data.serverTime)}` : 'Loading device records'}>
      {!data && loading ? <Spinner /> : !data ? <div className="form-error">{error || 'No data available.'}</div> : data.items.length === 0 ? <Empty>Android devices appear here automatically after registering with EMS and syncing with ConnectX Control at https://connectxweb.pages.dev.</Empty> : <div className="table-wrap"><table className="table monitor-devices-table"><thead><tr><th>Device</th><th>Shop / administrator</th><th>SIM</th><th>App</th><th>Status</th><th>Last seen</th><th></th></tr></thead><tbody>{data.items.map((device: MonitorDevice) => <tr key={device.id}>
        <td><div className="td-main">{device.deviceName}</div><div className="td-sub mono">{device.id}</div></td>
        <td><div className="td-main">{device.shopName || '—'}</div><div className="td-sub">{device.administratorName || device.administratorEmail || device.adminId}</div><div className="td-sub">{device.administratorCode || device.administratorEmail}</div></td>
        <td><div className="td-main">{device.simCarrier || (device.simSubscriptionId ? `SIM ${device.simSubscriptionId}` : '—')}</div><div className="td-sub">{device.phoneNumber || '—'}</div></td>
        <td><div className="td-main">{device.appVersion || '—'}{device.versionCode ? ` · ${device.versionCode}` : ''}</div><div className="td-sub">Android {device.androidVersion || '—'}</div></td>
        <td><Badge value={deviceStatus(device)} /></td>
        <td className="td-sub">{fmtDate(device.lastSeen)}</td>
        <td>{device.status === 'revoked' ? <Button variant="soft" onClick={() => { void changeAccess(device); }}>Restore</Button> : <Button variant="soft" onClick={() => { void changeAccess(device); }}>Revoke</Button>}</td>
      </tr>)}</tbody></table></div>}
      {error && data && <div className="form-error" role="status">{error}</div>}
      {data?.hasMore && <div className="monitor-load-more"><Button variant="soft" onClick={() => setOffset(offset + PAGE_SIZE)}>Load more</Button></div>}
    </Card>
    <p className="muted monitor-footnote">Device and shop authorization remain managed by EMS. Control stores a separate monitoring copy; SMS message bodies are never sent here.</p>
  </>;
}
