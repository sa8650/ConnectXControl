import React, { useCallback, useEffect, useState } from 'react';
import { api, Job, Shop, SystemInfo } from '../api/client';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, PageHead, Select,
  Spinner, TextArea, fmtDate, timeAgo, toast
} from '../components/ui';

const PAGE = 40;

export default function Jobs() {
  const [items, setItems] = useState<Job[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({ channel: '', status: '', shop_id: '', system_id: '', search: '' });
  const [shops, setShops] = useState<Shop[]>([]);
  const [systems, setSystems] = useState<SystemInfo[]>([]);
  const [detail, setDetail] = useState<Job | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Shop[]>('control/shops').then(setShops).catch(() => {});
    api.get<SystemInfo[]>('control/systems').then(setSystems).catch(() => {});
  }, []);

  const load = useCallback(async (off = 0) => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: String(PAGE), offset: String(off) });
      Object.entries(filters).forEach(([k, v]) => { if (v) q.set(k, v); });
      const res = await api.get<{ items: Job[]; hasMore: boolean }>(`control/jobs?${q}`);
      setItems(res.items); setHasMore(res.hasMore); setOffset(off); setError('');
    } catch (e: any) { setError(e?.message || 'Failed to load messages.'); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { load(0); }, [load]);

  async function act(job: Job, action: 'cancel' | 'retry') {
    if (action === 'cancel' && !confirm('Cancel this queued message?')) return;
    try {
      await api.post(`control/jobs/${encodeURIComponent(job.id)}/${action}`);
      toast(action === 'cancel' ? 'Message cancelled' : 'Message re-queued');
      setDetail(null); load(offset);
    } catch (e: any) { toast(e?.message || 'Failed', 'err'); }
  }

  return (
    <>
      <PageHead
        title="Messages"
        subtitle="Every SMS job and email record flowing through ConnectX — from any connected system or the console."
        actions={
          <>
            <Button variant="ghost" onClick={() => load(offset)}>↻ Refresh</Button>
            <Button onClick={() => setSendOpen(true)}>＋ Send test SMS</Button>
          </>
        }
      />

      <Card>
        <div className="filters">
          <Input className="search" placeholder="Search phone, name, text…"
            value={filters.search}
            onChange={e => setFilters({ ...filters, search: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') load(0); }} />
          <Select value={filters.channel} onChange={e => setFilters({ ...filters, channel: e.target.value })}>
            <option value="">All channels</option><option value="sms">SMS</option><option value="email">Email</option>
          </Select>
          <Select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Any status</option>
            {['queued', 'sending', 'sent', 'failed', 'cancelled'].map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Select value={filters.shop_id} onChange={e => setFilters({ ...filters, shop_id: e.target.value })}>
            <option value="">All shops</option>
            {shops.map(w => <option key={w.id} value={w.id}>{w.name}{w.system_name ? ` — ${w.system_name}` : ''}</option>)}
          </Select>
          <Select value={filters.system_id} onChange={e => setFilters({ ...filters, system_id: e.target.value })}>
            <option value="">All systems</option>
            {systems.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>

        {error && <div className="form-error">{error}</div>}
        {loading ? <div className="empty"><Spinner /></div> : items.length === 0 ? (
          <Empty>No messages match. Systems push jobs via the client API (see API Docs); you can also send a test SMS here.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>To</th><th>Type</th><th>System</th><th>Shop</th><th>Gateway</th><th>Status</th><th>Created</th><th></th></tr>
                </thead>
                <tbody>
                  {items.map(j => (
                    <tr key={j.id} onClick={() => setDetail(j)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="td-main mono">{j.channel === 'sms' ? j.to_phone : (j.to_emails || []).join(', ') || j.subject}</div>
                        <div className="td-sub">{j.recipient_name || ''}</div>
                      </td>
                      <td>
                        <div className="td-main">{j.message_type || j.channel.toUpperCase()}</div>
                        <div className="td-sub">{j.channel}{j.reference_number ? ` · ${j.reference_number}` : ''}</div>
                      </td>
                      <td>{j.system_name || <span className="td-sub">console/device</span>}</td>
                      <td>{j.shop_name || '—'}</td>
                      <td className="td-sub">{j.device_name || '—'}</td>
                      <td><Badge value={j.status} /></td>
                      <td className="td-sub" title={fmtDate(j.created_at)}>{timeAgo(j.created_at)}</td>
                      <td onClick={e => e.stopPropagation()}>
                        <div className="pill-row">
                          {j.status === 'queued' && <Button variant="danger" onClick={() => act(j, 'cancel')}>Cancel</Button>}
                          {['failed', 'cancelled'].includes(j.status) && j.channel === 'sms' &&
                            <Button variant="soft" onClick={() => act(j, 'retry')}>Retry</Button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-actions" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <Button variant="ghost" disabled={offset === 0} onClick={() => load(Math.max(0, offset - PAGE))}>← Prev</Button>
              <Button variant="ghost" disabled={!hasMore} onClick={() => load(offset + PAGE)}>Next →</Button>
            </div>
          </>
        )}
      </Card>

      {detail && <JobDetail job={detail} onClose={() => setDetail(null)} onCancel={() => act(detail, 'cancel')} onRetry={() => act(detail, 'retry')} />}
      {sendOpen && <SendTest onClose={() => setSendOpen(false)} onSent={() => { setSendOpen(false); load(0); }} shops={shops} />}
    </>
  );
}

function JobDetail({ job, onClose, onCancel, onRetry }: { job: Job; onClose: () => void; onCancel: () => void; onRetry: () => void }) {
  return (
    <Modal title={job.channel === 'sms' ? 'SMS job' : 'Email record'} onClose={onClose} wide>
      <dl className="kv">
        <dt>Status</dt><dd><Badge value={job.status} /></dd>
        <dt>Job ID</dt><dd className="mono">{job.id}</dd>
        <dt>Channel</dt><dd>{job.channel}</dd>
        <dt>System</dt><dd>{job.system_name || 'console/device'}</dd>
        <dt>Shop</dt><dd>{job.shop_name || '—'}{job.shop_external_id ? <span className="mono muted"> ({job.shop_external_id})</span> : null}</dd>
        {job.channel === 'sms' && <><dt>To phone</dt><dd className="mono">{job.to_phone}</dd></>}
        {job.channel === 'email' && <>
          <dt>To</dt><dd>{(job.to_emails || []).join(', ')}</dd>
          <dt>Subject</dt><dd>{job.subject || '—'}</dd>
        </>}
        <dt>Recipient</dt><dd>{job.recipient_name || '—'}</dd>
        <dt>Message type</dt><dd>{job.message_type || '—'}{job.event_type ? ` (${job.event_type})` : ''}</dd>
        {job.reference_number && <><dt>Reference</dt><dd className="mono">{job.reference_number}</dd></>}
        <dt>Gateway</dt><dd>{job.device_name || '—'} {job.attempts ? <span className="muted">· {job.attempts}/{job.max_attempts} attempts</span> : null}</dd>
        <dt>Created</dt><dd>{fmtDate(job.created_at)}</dd>
        <dt>Sent</dt><dd>{fmtDate(job.sent_at)}</dd>
        {job.error_message && <><dt>Error</dt><dd style={{ color: 'var(--bad)' }}>{job.error_message}</dd></>}
        {job.message_body && <><dt>Body</dt><dd><pre className="code" style={{ margin: 0 }}>{job.message_body}</pre></dd></>}
      </dl>
      <div className="pill-row" style={{ marginTop: 14 }}>
        {job.status === 'queued' && <Button variant="danger" onClick={onCancel}>Cancel job</Button>}
        {['failed', 'cancelled'].includes(job.status) && job.channel === 'sms' && <Button variant="soft" onClick={onRetry}>Retry</Button>}
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

function SendTest({ onClose, onSent, shops }: { onClose: () => void; onSent: () => void; shops: Shop[] }) {
  const [ws, setWs] = useState(shops.find(w => w.status === 'active')?.id || '');
  const [to, setTo] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('ConnectX test message from the control website.');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!ws) setWs(shops.find(w => w.status === 'active')?.id || ''); }, [shops, ws]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('control/jobs', { shop_id: ws, to, recipient_name: name, message, message_type: 'TEST' });
      toast('Test SMS queued — an online gateway will dispatch it');
      onSent();
    } catch (err: any) { toast(err?.message || 'Failed', 'err'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Send a test SMS" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Shop" hint="The shop whose gateway will deliver this test message.">
          <Select value={ws} onChange={e => setWs(e.target.value)} required>
            {shops.filter(w => w.status === 'active').map(w => <option key={w.id} value={w.id}>{w.name}{w.system_name ? ` — ${w.system_name}` : ''}</option>)}
          </Select>
        </Field>
        <div className="form-row">
          <Field label="To (phone)">
            <Input value={to} onChange={e => setTo(e.target.value)} placeholder="+8801XXXXXXXXX" required />
          </Field>
          <Field label="Recipient name">
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <Field label="Message">
          <TextArea value={message} onChange={e => setMessage(e.target.value)} required maxLength={1600} />
        </Field>
        <Button type="submit" disabled={busy || !ws}>{busy ? 'Queueing…' : 'Queue SMS'}</Button>
      </form>
    </Modal>
  );
}
