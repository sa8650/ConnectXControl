import Database from 'better-sqlite3';

/** Small Cloudflare D1-compatible wrapper backed by in-memory SQLite. */
export function createFakeD1(schemaSql) {
  const sqlite = new Database(':memory:');
  if (schemaSql) sqlite.exec(schemaSql);

  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() {
              return statement.get(...params) ?? null;
            },
            async all() {
              return { results: statement.all(...params) };
            },
            async run() {
              const result = statement.run(...params);
              return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
            }
          };
        }
      };
    }
  };

  return { DB, sqlite, close: () => sqlite.close() };
}
