import React, { useCallback, useEffect, useState } from 'react';
import { api, Device, Shop } from '../api/client';
import {
  Badge, Button, Card, CopyButton, Empty, Field, Modal, PageHead,
  Select, Spinner, fmtDate, timeAgo, toast
} from '../components/ui';

export default function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairShop, setPairShop] = useState('');
  const [pairTtl, setPairTtl] = useState('60');
  const [pairResult, setPairResult] = useState<{ code: string; shop: string; ttl: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        api.get<Device[]>('control/devices'),
        api.get<Shop[]>('control/shops?status=active')
      ]);
      setDevices(d); setShops(s);
      setError('');
    } catch (e: any) { setError(e?.message || 'Failed to load gateways.'); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  async function createPairing(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ code: string; expires_in_minutes: number }>('control/devices/pairing-code', {
        shop_id: pairShop, ttl_minutes: Number(pairTtl)
      });
      setPairResult({ code: res.code, shop: shops.find(s => s.id === pairShop)?.name || '', ttl: res.expires_in_minutes });
      toast('Pairing code created');
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  async function act(id: string, action: 'revoke' | 'restore' | 'primary') {
    const label = { revoke: 'revoke', restore: 'restore', primary: 'set as primary' }[action];
    if (action === 'revoke' && !confirm('Revoke this gateway? The phone must pair again.')) return;
    try {
      await api.post(`control/devices/${encodeURIComponent(id)}/${action}`);
      toast(`Gateway ${label}d`);
      load();
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  if (error) return <Card title="Gateways"><div className="form-error">{error}</div></Card>;
  if (!devices) return <div className="center-screen"><Spinner /></div>;

  return (
    <>
      <PageHead
        title="Android Gateways"
        subtitle="Phones running the ConnectX gateway app. They pair with a shop of a connected system, claim queued SMS and dispatch them through their SIM."
        actions={
          <Button onClick={() => { setPairOpen(true); setPairResult(null); setPairShop(shops[0]?.id || ''); }}>
            ＋ Pair new gateway
          </Button>
        }
      />

      <Card>
        {devices.length === 0 ? (
          <Empty>
            No gateways yet. Create a pairing code, then open the ConnectX app on the phone and
            enter the code — or sign in as a system administrator in the app and pick a shop.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th><th>Shop</th><th>System</th><th>SIM</th><th>Status</th>
                  <th>Last seen</th><th>App</th><th></th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.id}>
                    <td>
                      <div className="td-main">
                        {d.device_name || 'Android gateway'}{' '}
                        {d.is_primary && <span className="badge badge-info">primary</span>}
                      </div>
                      <div className="td-sub mono">{d.device_public_id}</div>
                    </td>
                    <td>
                      <div className="td-main">{d.shop_name || '—'}</div>
                      <div className="td-sub mono">{d.shop_external_id || ''}</div>
                    </td>
                    <td className="td-sub">{d.system_name || '—'}</td>
                    <td>
                      <div className="td-main">{d.sim_carrier || '—'}</div>
                      <div className="td-sub mono">{d.phone_number || ''}</div>
                    </td>
                    <td>
                      <Badge value={d.status} />{' '}
                      {d.status !== 'revoked' && (d.online
                        ? <Badge value="online" />
                        : <Badge value="offline" tone="muted" />)}
                    </td>
                    <td className="td-sub" title={fmtDate(d.last_seen)}>{timeAgo(d.last_seen)}</td>
                    <td className="td-sub">
                      v{d.app_version || '?'}<br />Android {d.android_version || '?'}
                    </td>
                    <td>
                      <div className="pill-row">
                        {d.status !== 'revoked' && <>
                          <Button variant="ghost" onClick={() => act(d.id, 'primary')} disabled={d.is_primary}>Primary</Button>
                          <Button variant="danger" onClick={() => act(d.id, 'revoke')}>Revoke</Button>
                        </>}
                        {d.status === 'revoked' && <span className="td-sub">revoked — pair again</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pairOpen && (
        <Modal title="Pair an Android gateway" onClose={() => setPairOpen(false)}>
          {!pairResult ? (
            <form onSubmit={createPairing}>
              <div className="form-note">
                On the phone: open the ConnectX app → “Pair with a code instead” → type the code
                below. The app connects to ConnectX automatically; no website URL or system
                credentials are needed on the phone.
              </div>
              <Field label="Shop" hint="The shop this gateway will deliver messages for. Shops sync automatically when a system administrator signs in on the phone.">
                <Select value={pairShop} onChange={e => setPairShop(e.target.value)} required>
                  {shops.length === 0 && <option value="">No active shops yet</option>}
                  {shops.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.system_name ? ` — ${s.system_name}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Code validity" hint="How long the code stays usable.">
                <Select value={pairTtl} onChange={e => setPairTtl(e.target.value)}>
                  <option value="15">15 minutes</option>
                  <option value="60">1 hour</option>
                  <option value="360">6 hours</option>
                  <option value="1440">24 hours</option>
                </Select>
              </Field>
              <Button type="submit" disabled={busy || !pairShop}>{busy ? 'Creating…' : 'Generate pairing code'}</Button>
            </form>
          ) : (
            <div>
              <p className="muted">Share this code with the phone. Shop: <strong>{pairResult.shop}</strong> · valid {pairResult.ttl} minutes.</p>
              <div className="pairing-code">{pairResult.code}</div>
              <div className="pill-row" style={{ justifyContent: 'center' }}>
                <CopyButton value={pairResult.code} label="Copy code" />
              </div>
              <p className="field-hint" style={{ marginTop: 14 }}>
                The app already knows the ConnectX control address. Only if it cannot reach it will
                the phone ask for a URL — then enter <span className="mono">{window.location.origin}</span>.
              </p>
              <div style={{ marginTop: 12 }}>
                <Button variant="ghost" onClick={() => { setPairOpen(false); load(); }}>Done</Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
