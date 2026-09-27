import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Button, Card, Empty, PageHead, Select, timeAgo, toast } from '../components/ui';

type Job = {
  id: string; request_id: string; recipient: string; message: string; status: string;
  sim_used?: string; reason?: string; remote_name?: string; connection_id?: string;
  created_at: string; result_at?: string; callback_status?: string;
};
type Conn = { id: string; display_name?: string; remote_application_name?: string; status?: string };

export default function Jobs() {
  const [items, setItems] = useState<Job[]>([]);
  const [apps, setApps] = useState<Conn[]>([]);
  const [status, setStatus] = useState('');
  const [connection, setConnection] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Job | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (connection) params.set('connection', connection);
      const q = params.toString() ? `?${params}` : '';
      const res = await api.get<{ items: Job[] }>(`control/connect/jobs${q}`);
      setItems(res.items || []);
      setError('');
    } catch (e: any) { setError(e?.message || 'Could not load messages.'); }
  }, [status, connection]);

  useEffect(() => {
    api.get<{ connections: Conn[] }>('control/connect')
      .then(res => setApps(res.connections || []))
      .catch(() => setApps([]));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  return (
    <>
      <PageHead
        title="Messages"
        subtitle="PENDING waits for the phone. PROCESSING means the phone has the task. SUCCESS or FAILED is sent back to the product that asked."
        actions={<Button variant="ghost" onClick={load}>Refresh</Button>}
      />
      <Card>
        <div className="filters">
          <Select value={connection} onChange={e => setConnection(e.target.value)}>
            <option value="">All connected apps</option>
            {apps.map(a => <option key={a.id} value={a.id}>{a.display_name || a.remote_application_name || a.id}</option>)}
          </Select>
          <Select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'].map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
        {error && <div className="form-error">{error}</div>}
        {items.length === 0 ? <Empty>No Connect App SMS yet.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Request</th><th>To</th><th>From</th><th>Status</th><th>SIM</th><th>When</th></tr></thead>
            <tbody>{items.map(j => (
              <tr key={j.id} onClick={() => setOpen(j)} style={{ cursor: 'pointer' }}>
                <td className="mono">{j.request_id}</td>
                <td>{j.recipient}</td>
                <td>{j.remote_name || '—'}</td>
                <td><Badge value={j.status} tone={j.status === 'SUCCESS' ? 'good' : j.status === 'FAILED' ? 'bad' : j.status === 'PROCESSING' ? 'info' : 'warn'} /></td>
                <td>{j.sim_used || '—'}</td>
                <td>{timeAgo(j.result_at || j.created_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {open && (
        <Card title={open.request_id} subtitle={open.status} actions={<Button variant="ghost" onClick={() => setOpen(null)}>Close</Button>}>
          <p>{open.message}</p>
          <p className="muted">To {open.recipient}{open.sim_used ? ` · SIM ${open.sim_used}` : ''}{open.reason ? ` · ${open.reason}` : ''}</p>
          <p className="muted">Result callback: {open.callback_status || '—'}</p>
          {open.callback_status === 'PENDING' && (
            <Button onClick={async () => {
              try { await api.post(`control/connect/jobs/${encodeURIComponent(open.id)}/retry-callback`); toast('Result sent back'); setOpen(null); load(); }
              catch (e: any) { toast(e?.message || 'Callback failed', 'err'); }
            }}>Send result again</Button>
          )}
        </Card>
      )}
    </>
  );
}
