import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const dbPath = resolve(process.env.REVIEW_MCP_DB_PATH ?? "./review-mcp.db");
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  return db;
}

export function resetDb(): void {
  db?.close();
  db = null;
}

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS entity_metadata (
    entity_id TEXT PRIMARY KEY,
    name TEXT,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('user','ai','tool')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS review_trail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT DEFAULT '',
    created_by TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_entity_metadata_updated ON entity_metadata(updated_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_entity_metadata_name ON entity_metadata(name)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_trail_entity ON review_trail(entity_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_trail_action ON review_trail(action)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_trail_created ON review_trail(created_at)",
  );
}
