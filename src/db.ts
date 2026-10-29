import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Schema generation.
 *
 * There are no migrations: the database is a working file under `DSH_HOME` and is
 * cheaper to delete than to carry forward. The stamp is what turns a stale file
 * into a sentence an operator can act on, instead of a SQLite error halfway through
 * a write. Bump it whenever the tables below change.
 */
const SCHEMA_VERSION = 1;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const dbPath = resolve(process.env.REVIEW_MCP_DB_PATH ?? './review-mcp.db');
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  migrate(db);
  return db;
}

export function resetDb(): void {
  db?.close();
  db = null;
}

/**
 * Create the knowledge base, refusing a file this build does not understand.
 *
 * Everything stored is authored meaning about an artifact revision — this server
 * never stores a measurement. Two shapes are distinct enough to be separate tables
 * rather than one table with a `kind` column, because their identity and their write
 * semantics differ:
 *
 * - A **review** names or annotates geometry: `entity_ids` are the substrate, plus an
 *   optional name (a semantic feature) and optional note and tags. A named review is
 *   keyed by locator and name and REPLACES on re-remember. An unnamed review is a note
 *   anchored to an entity set and APPENDS to it.
 * - A **decision** concludes something about a revision: a subject, a disposition, and
 *   a basis of requirement-checks. It is keyed by locator, revision, and subject, and is
 *   always replaced as a whole, never appended to — half of an old disposition merged
 *   with half of a new one records nothing.
 * @param db - open database handle.
 * @throws when the file was written by a build whose schema this one does not share.
 */
function migrate(db: DatabaseSync): void {
  const { tables } = db
    .prepare("SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table'")
    .get() as { tables: number };
  if (tables === 0) {
    db.exec(`CREATE TABLE reviews (
      review_key TEXT PRIMARY KEY,           -- source_file|name   OR   source_file|@entities-json
      source_file TEXT NOT NULL,             -- canonical artifact locator
      name TEXT,                             -- NULL for an anonymous note
      entity_ids TEXT NOT NULL,              -- JSON array
      note TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',       -- JSON array
      model_revision TEXT NOT NULL,          -- revision the review was written against
      entity_id_scheme TEXT NOT NULL,
      artifact_units TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec('CREATE INDEX idx_reviews_source ON reviews(source_file)');
    db.exec('CREATE INDEX idx_reviews_name ON reviews(source_file, name)');

    db.exec(`CREATE TABLE decisions (
      decision_key TEXT PRIMARY KEY,         -- source_file|revision|subject
      source_file TEXT NOT NULL,             -- canonical artifact locator
      model_revision TEXT NOT NULL,          -- revision the decision is bound to
      subject TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed')),
      basis TEXT NOT NULL,                   -- JSON array of basis items
      entity_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of every face the basis names
      artifact_units TEXT,
      supersedes TEXT,                       -- revision whose decision this replaces
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec('CREATE INDEX idx_decisions_source ON decisions(source_file)');
    db.exec('CREATE INDEX idx_decisions_subject ON decisions(source_file, subject)');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `review database is at schema version ${version}, this build writes version ${SCHEMA_VERSION}. ` +
        'There are no migrations; delete the database file and let it be recreated.',
    );
  }
}
