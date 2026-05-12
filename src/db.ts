import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export interface UserRecord {
  id: number;
  telegram_username: string | null;
  github_login: string;
  encrypted_pat: string;
  created_at: string;
  updated_at: string;
}

let db: Database.Database | null = null;

export function initDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      telegram_username TEXT,
      github_login TEXT NOT NULL,
      encrypted_pat TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const hasLegacyColumn = db
    .prepare(`SELECT 1 FROM pragma_table_info('users') WHERE name = 'telegram_id'`)
    .get();
  if (hasLegacyColumn) {
    db.exec(`ALTER TABLE users RENAME COLUMN telegram_id TO id`);
  }
}

function requireDb(): Database.Database {
  if (!db) throw new Error('DB not initialised. Call initDb first.');
  return db;
}

export function getUser(telegramId: number): UserRecord | undefined {
  return requireDb()
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .get(telegramId) as UserRecord | undefined;
}

export interface UpsertUserInput {
  id: number;
  telegram_username: string | null;
  github_login: string;
  encrypted_pat: string;
}

export function upsertUser(u: UpsertUserInput): void {
  const now = new Date().toISOString();
  requireDb()
    .prepare(
      `INSERT INTO users
         (id, telegram_username, github_login, encrypted_pat, created_at, updated_at)
       VALUES
         (@id, @telegram_username, @github_login, @encrypted_pat, @now, @now)
       ON CONFLICT(id) DO UPDATE SET
         telegram_username = excluded.telegram_username,
         github_login      = excluded.github_login,
         encrypted_pat     = excluded.encrypted_pat,
         updated_at        = excluded.updated_at`,
    )
    .run({ ...u, now });
}
