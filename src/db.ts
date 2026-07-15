import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  const dbPath = resolve(process.env.REVIEW_MCP_DB_PATH ?? './review-mcp.db')
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('tag','note','claim')),
    text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','rejected')),
    source TEXT NOT NULL CHECK (source IN ('user','ai','tool')),
    confidence REAL,
    evidence_json TEXT,
    created_by TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS annotation_entities (
    annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (annotation_id, entity_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS review_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_by TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES review_groups(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (group_id, entity_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS review_trail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT DEFAULT '',
    created_by TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec("CREATE INDEX IF NOT EXISTS idx_annotations_kind ON annotations(kind)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_annotations_status ON annotations(status)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_annotations_updated ON annotations(updated_at)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_annotation_entities_entity ON annotation_entities(entity_id)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_group_members_gid ON group_members(group_id)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_trail_entity ON review_trail(entity_id)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_trail_action ON review_trail(action)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_trail_created ON review_trail(created_at)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_groups_name ON review_groups(name)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_groups_created ON review_groups(created_at)")
}
