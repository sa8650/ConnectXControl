import React, { useCallback, useEffect, useState } from 'react';
import { api, Device, Workspace } from '../api/client';
import {
  Badge, Button, Card, CopyButton, Empty, Field, Input, Modal, PageHead,
  Select, Spinner, fmtDate, timeAgo, toast
} from '../components/ui';

export default function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairWs, setPairWs] = useState('');
  const [pairTtl, setPairTtl] = useState('60');
  const [pairResult, setPairResult] = useState<{ code: string; ws: string; ttl: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, w] = await Promise.all([
        api.get<Device[]>('control/devices'),
        api.get<Workspace[]>('control/workspaces')
      ]);
      setDevices(d); setWorkspaces(w.filter(x => x.status === 'active'));
      setError('');
    } catch (e: any) { setError(e?.message || 'Failed to load gateways.'); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  async function createPairing(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ code: string; expires_in_minutes: number }>('control/devices/pairing-code', {
        workspace_id: pairWs, ttl_minutes: Number(pairTtl)
      });
      setPairResult({ code: res.code, ws: workspaces.find(w => w.id === pairWs)?.name || '', ttl: res.expires_in_minutes });
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
        subtitle="Phones running the ConnectX gateway app. They pair with a workspace, claim queued SMS and dispatch them through their SIM."
        actions={
          <Button onClick={() => { setPairOpen(true); setPairResult(null); setPairWs(workspaces[0]?.id || ''); }}>
            ＋ Pair new gateway
          </Button>
        }
      />

      <Card>
        {devices.length === 0 ? (
          <Empty>
            No gateways yet. Create a pairing code, then open the ConnectX app on the phone,
            enter this website's URL and the code.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th><th>Workspace</th><th>SIM</th><th>Status</th>
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
                      <div className="td-main">{d.workspace_name || '—'}</div>
                      <div className="td-sub mono">{d.workspace_code}</div>
                    </td>
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
                On the phone: install the ConnectX app → enter this website's full URL → choose
                “Pair with a code instead” → type the code below. Alternatively an operator
                account can sign in on the phone and pick a workspace.
              </div>
              <Field label="Workspace">
                <Select value={pairWs} onChange={e => setPairWs(e.target.value)} required>
                  {workspaces.length === 0 && <option value="">No active workspace — create one first</option>}
                  {workspaces.map(w => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
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
              <Button type="submit" disabled={busy || !pairWs}>{busy ? 'Creating…' : 'Generate pairing code'}</Button>
            </form>
          ) : (
            <div>
              <p className="muted">Share this code with the phone. Workspace: <strong>{pairResult.ws}</strong> · valid {pairResult.ttl} minutes.</p>
              <div className="pairing-code">{pairResult.code}</div>
              <div className="pill-row" style={{ justifyContent: 'center' }}>
                <CopyButton value={pairResult.code} label="Copy code" />
                <CopyButton value={`${window.location.origin}\n${pairResult.code}`} label="Copy URL + code" />
              </div>
              <p className="field-hint" style={{ marginTop: 14 }}>
                The gateway website URL for the phone is: <span className="mono">{window.location.origin}</span>
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
