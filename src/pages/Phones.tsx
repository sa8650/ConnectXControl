import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Button, Card, Empty, PageHead, Stat, timeAgo } from '../components/ui';

type Version = { app_version: string; version_code: number; count: number };
type Phone = {
  id: string; device_name: string; shop_name: string; admin_email: string; admin_name: string;
  status: string; online: boolean; app_version: string; version_code: number | null;
  android_version: string; last_seen_at?: string | null; created_at: string;
};
type Overview = { installed: number; online: number; versions: Version[]; phones: Phone[] };

function versionLabel(phone: Phone) {
  if (!phone.app_version) return 'Not reported yet';
  return phone.version_code ? `v${phone.app_version} · build ${phone.version_code}` : `v${phone.app_version}`;
}

export default function Phones() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.get<Overview>('control/phones'));
      setError('');
    } catch (e: any) { setError(e?.message || 'Could not load Android phones.'); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  if (error && !data) return <Card title="Android Phones"><div className="form-error">{error}</div></Card>;
  if (!data) return <div className="center-screen">Loading Android phones…</div>;

  const latest = data.versions.find(v => v.app_version !== 'Not reported') || data.versions[0];

  return (
    <>
      <PageHead
        title="Android Phones"
        subtitle="Phones that signed in to ConnectX. Install count, app version and build come from the app itself."
        actions={<Button variant="ghost" onClick={load}>Refresh</Button>}
      />
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Installed" value={data.installed} tone={data.installed ? 'good' : 'warn'} hint="signed-in phones, not disconnected" />
        <Stat label="Online now" value={data.online} tone={data.online ? 'good' : 'default'} hint="seen in the last 3 minutes" />
        <Stat
          label="App version"
          value={latest && latest.app_version !== 'Not reported' ? latest.app_version : '—'}
          hint={latest?.version_code ? `build ${latest.version_code} · ${latest.count} phone${latest.count === 1 ? '' : 's'}` : 'reported on the next sign-in'}
        />
      </div>
      <Card title="Installs">
        {data.phones.length === 0 ? <Empty>No Android app has signed in yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Phone</th><th>Shop</th><th>Version</th><th>Build</th><th>Status</th><th>Last seen</th></tr></thead>
            <tbody>{data.phones.map(p => (
              <tr key={p.id}>
                <td className="td-main">{p.device_name}<div className="muted">{p.admin_name || p.admin_email || 'Administrator'}</div></td>
                <td>{p.shop_name || '—'}</td>
                <td>{p.app_version || '—'}</td>
                <td className="mono">{p.version_code || '—'}</td>
                <td>{p.status === 'disconnected'
                  ? <Badge value="Disconnected" tone="muted" />
                  : p.online ? <span className="badge badge-good"><i className="live-dot" /> Online</span> : <Badge value="Installed" tone="info" />}</td>
                <td>{p.last_seen_at ? timeAgo(p.last_seen_at) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {data.phones.some(p => !p.app_version) && (
          <p className="muted" style={{ marginTop: 12 }}>{versionLabel(data.phones.find(p => !p.app_version) || data.phones[0])} until that phone opens the current app.</p>
        )}
      </Card>
    </>
  );
}
