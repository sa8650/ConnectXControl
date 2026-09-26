/* =====================================================================
   ConnectX Control — D1 helper
   A very thin wrapper over the Cloudflare D1 binding so every route uses
   parameterised SQL. In tests the same interface is backed by an
   in-memory SQLite stub (see test/helpers/fakeD1.js).
   ===================================================================== */

function dbOf(env) {
  const db = env && env.DB;
  if (!db) throw new Error('D1 binding DB is not configured.');
  return db;
}

/** Run a parameterised query and return all rows. */
export async function all(env, sql, ...binds) {
  const { results } = await dbOf(env).prepare(sql).bind(...binds).all();
  return results || [];
}

/** Run a parameterised query and return the first row (or null). */
export async function get(env, sql, ...binds) {
  const row = await dbOf(env).prepare(sql).bind(...binds).first();
  return row || null;
}

/** Run a parameterised statement (INSERT/UPDATE/DELETE); returns meta. */
export async function run(env, sql, ...binds) {
  return dbOf(env).prepare(sql).bind(...binds).run();
}

/** Insert an object into a table. Column values are bound positionally. */
export async function insert(env, table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  await run(env, sql, ...cols.map(c => normalize(row[c])));
  return row;
}

/** Update rows matching a where fragment (with binds). Returns changes count. */
export async function update(env, table, setObj, whereSql, ...whereBinds) {
  const cols = Object.keys(setObj);
  if (!cols.length) return 0;
  const sql = `UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE ${whereSql}`;
  const result = await run(env, sql, ...cols.map(c => normalize(setObj[c])), ...whereBinds);
  return result?.meta?.changes ?? 0;
}

/** D1 stores booleans as 0/1 and objects/arrays as JSON text. */
export function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Parse a JSON text column, tolerating null/invalid values. */
export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/* ---------- small query builders ---------- */
export function inClause(values) {
  return { sql: values.map(() => '?').join(', '), binds: values };
}
