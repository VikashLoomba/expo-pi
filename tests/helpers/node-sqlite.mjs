import { DatabaseSync } from 'node:sqlite';

/** Expo's async native boundary backed by an actual SQLite database for tests. */
export function createNodeSqliteConnection(filename = ':memory:') {
  const database = new DatabaseSync(filename);
  return {
    async execAsync(sql) { database.exec(sql); },
    async runAsync(sql, params = []) { return database.prepare(sql).run(...params); },
    async getFirstAsync(sql, params = []) { return database.prepare(sql).get(...params) ?? null; },
    async getAllAsync(sql, params = []) { return database.prepare(sql).all(...params); },
    async closeAsync() { database.close(); },
  };
}
