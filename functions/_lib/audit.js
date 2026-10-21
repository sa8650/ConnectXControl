/* Audit trail shared by control, device and client routes. */
import { insert, all } from './db.js';
import { uuid, nowIso } from './core.js';

export async function logActivity(env, {
  actorType = 'system', actorId = null, actorLabel = null,
  action, entityType = null, entityId = null, meta = null
}) {
  try {
    await insert(env, 'cx_activity_log', {
      id: uuid(),
      actor_type: actorType,
      actor_id: actorId,
      actor_label: actorLabel ? String(actorLabel).slice(0, 160) : null,
      action: String(action).slice(0, 160),
      entity_type: entityType,
      entity_id: entityId ? String(entityId) : null,
      meta: meta ? JSON.stringify(meta) : null,
      created_at: nowIso()
    });
  } catch (e) {
    console.error('audit log failed', e);
  }
}

export async function recentActivity(env, limit = 100) {
  const rows = await all(env,
    'SELECT * FROM cx_activity_log ORDER BY created_at DESC LIMIT ?', Math.min(500, Number(limit) || 100));
  return rows.map(r => ({ ...r, meta: r.meta ? safeParse(r.meta) : null }));
}

function safeParse(v) { try { return JSON.parse(v); } catch { return null; } }
