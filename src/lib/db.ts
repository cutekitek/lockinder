import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

export function openDatabase(path = process.env.DATABASE_PATH || './data/lockinder.db') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL)');
  sqlite.transaction(() => {
    for (const name of readdirSync(resolve('migrations')).filter(n => n.endsWith('.sql')).sort()) {
      if (!sqlite.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name)) {
        sqlite.exec(readFileSync(resolve('migrations', name), 'utf8'));
        sqlite.prepare('INSERT INTO _migrations VALUES (?)').run(name);
      }
    }
  }).immediate();
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
type Connection = ReturnType<typeof openDatabase>;
const globalDb = globalThis as unknown as { lockinder?: Connection };
export function connection() { return globalDb.lockinder ??= openDatabase(); }
export function db() { return connection().db; }

export function backupDatabase(destination: string, sqlite = connection().sqlite) {
  const path = resolve(destination);
  if (existsSync(path)) throw new Error('Backup destination must not exist');
  // VACUUM INTO creates a consistent snapshot, including committed WAL changes.
  sqlite.run('VACUUM INTO ?', [path]);
}
