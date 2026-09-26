import React, { useCallback, useEffect, useState } from 'react';
import { api, ActivityItem } from '../api/client';
import { Badge, Card, Empty, PageHead, Spinner, fmtDate, timeAgo } from '../components/ui';

export default function Activity() {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setItems((await api.get<{ items: ActivityItem[] }>('control/activity?limit=200')).items); setError(''); }
    catch (e: any) { setError(e?.message || 'Failed to load activity.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <Card title="Activity"><div className="form-error">{error}</div></Card>;
  if (!items) return <div className="center-screen"><Spinner /></div>;

  return (
    <>
      <PageHead title="Activity" subtitle="Audit trail: who signed in, paired or revoked gateways, issued keys, published releases, cancelled jobs." />
      <Card>
        {items.length === 0 ? <Empty>No activity recorded yet.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
              <tbody>
                {items.map(a => (
                  <tr key={a.id}>
                    <td className="td-sub" title={fmtDate(a.created_at)}>{timeAgo(a.created_at)}</td>
                    <td>
                      <Badge value={a.actor_type} tone={a.actor_type === 'owner' ? 'info' : a.actor_type === 'device' ? 'warn' : a.actor_type === 'client' ? 'good' : 'muted'} />{' '}
                      <span className="td-main">{a.actor_label || '—'}</span>
                    </td>
                    <td className="td-main">{a.action}</td>
                    <td className="td-sub mono">{a.entity_type ? `${a.entity_type}${a.entity_id ? ` · ${String(a.entity_id).slice(0, 12)}` : ''}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
