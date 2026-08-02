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
  const existingColumns = db
    .prepare("PRAGMA table_info(entity_metadata)")
    .all() as Array<{ name: string }>;
  if (existingColumns.length && !existingColumns.some((column) => column.name === "subject_key")) {
    db.exec("ALTER TABLE entity_metadata RENAME TO entity_metadata_legacy");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS entity_metadata (
    subject_key TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    model_revision TEXT NOT NULL,
    name TEXT,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('user','ai','tool')),
    evidence_ids TEXT NOT NULL DEFAULT '[]',
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
  if (existingColumns.length && !existingColumns.some((column) => column.name === "subject_key")) {
    db.exec(`INSERT INTO entity_metadata (
      subject_key, entity_id, model_revision, name, note, source, evidence_ids, created_at, updated_at
    )
    SELECT entity_id, entity_id, 'legacy', name, note, source, '[]', created_at, updated_at
    FROM entity_metadata_legacy`);
    db.exec("DROP TABLE entity_metadata_legacy");
  }
  const trailColumns = db
    .prepare("PRAGMA table_info(review_trail)")
    .all() as Array<{ name: string }>;
  if (trailColumns.length) {
    if (!trailColumns.some((column) => column.name === "model_revision")) {
      db.exec("ALTER TABLE review_trail ADD COLUMN model_revision TEXT");
    }
    if (!trailColumns.some((column) => column.name === "evidence_ids")) {
      db.exec("ALTER TABLE review_trail ADD COLUMN evidence_ids TEXT NOT NULL DEFAULT '[]'");
    }
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_entity_metadata_updated ON entity_metadata(updated_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_entity_metadata_name ON entity_metadata(name)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_entity_metadata_subject ON entity_metadata(entity_id, model_revision)",
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
