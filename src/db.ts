import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const dbPath = resolve(process.env.REVIEW_MCP_DB_PATH ?? './review-mcp.db');
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  return db;
}

export function resetDb(): void {
  db?.close();
  db = null;
}

// Clean, unified knowledge base. A "review" is one durable unit of meaning
// tied to geometry: entities[] (the substrate) + optional name (a semantic
// feature) + optional note + tags[].
//
// Identity rules:
//   - A NAMED review (name set) is a FEATURE and is keyed by (source_file, name).
//     Re-remembering the same name REPLACES it (supports the viewer's
//     correct-the-AI loop).
//   - An UNNAMED review (name NULL) is a NOTE anchored to an entity set.
//     It stores the resolved entities as a stable JSON key so re-remembering
//     the same entity with no name APPENDS facts.
function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS reviews (
    review_key TEXT PRIMARY KEY,           -- source_file|name   OR   source_file|@entities-json
    source_file TEXT NOT NULL,
    name TEXT,                             -- NULL for anonymous notes
    entity_ids TEXT NOT NULL,              -- JSON array
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    author TEXT NOT NULL DEFAULT 'ai',
    model_revision TEXT NOT NULL,          -- sha256 content hash at write time
    entity_id_scheme TEXT NOT NULL DEFAULT 'occt-topology-v1',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  const columns = new Set(
    (db.prepare('PRAGMA table_info(reviews)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('entity_id_scheme')) {
    db.exec(
      "ALTER TABLE reviews ADD COLUMN entity_id_scheme TEXT NOT NULL DEFAULT 'occt-topology-v1'",
    );
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_source ON reviews(source_file)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_name ON reviews(source_file, name)');
}
