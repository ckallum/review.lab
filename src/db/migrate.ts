import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migration system for the per-repo SQLite database.
 *
 * Conventions (matches `.claude/specs/review-dev-mvp/design.md`):
 *   - Files at `migrations/NNN_<slug>.sql` apply forward-only in numeric order.
 *   - The `meta` table records which versions have been applied.
 *   - Each file runs inside a single `db.transaction(...).immediate(...)`
 *     so a partially-applied migration rolls back cleanly.
 *   - `openDb` always sets `journal_mode = WAL` and `foreign_keys = ON`.
 *
 * The `meta` table lives here (not in 001_initial.sql) because it's part
 * of the migration *system*, not the data model. Numbered migrations may
 * not assume the meta table exists; `applyMigrations` creates it first.
 */

export type Migration = {
  version: number;
  filename: string;
  path: string;
};

export type AppliedMigration = {
  version: number;
  filename: string;
  applied_at: string;
};

const META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    version INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

// Matches "001_initial.sql", "042_add_foo.sql" etc. Captures the version.
const MIGRATION_FILENAME = /^(\d+)_[A-Za-z0-9_-]+\.sql$/;

/**
 * Open the per-repo SQLite database. Creates the file if missing, sets
 * WAL mode for concurrent reads alongside the publish-writer, and turns
 * on foreign-key enforcement (off by default in SQLite for legacy reasons).
 *
 * Pass `:memory:` for an ephemeral database in tests.
 */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * List every numbered migration file in `dir`, sorted by version.
 * Files that don't match the `NNN_<slug>.sql` pattern are skipped silently.
 */
export function listMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .map((filename) => {
      const match = filename.match(MIGRATION_FILENAME);
      if (!match) return null;
      return {
        version: Number(match[1]),
        filename,
        path: join(dir, filename),
      };
    })
    .filter((m): m is Migration => m !== null)
    .sort((a, b) => a.version - b.version);
}

/**
 * Apply every migration in `dir` that hasn't already been recorded in
 * `meta`. Returns the migrations that ran on this call (empty list if
 * the DB was already up to date).
 *
 * Each migration runs inside its own `db.transaction(...).immediate(...)`.
 * If one fails midway, the transaction rolls back and the error propagates.
 * Earlier migrations stay applied.
 */
export function applyMigrations(db: Database, dir: string): AppliedMigration[] {
  db.exec(META_TABLE_DDL);

  const applied = new Set<number>(
    db
      .query<{ version: number }, []>('SELECT version FROM meta')
      .all()
      .map((row) => row.version),
  );

  const ran: AppliedMigration[] = [];

  // `db.transaction(...).immediate(...)` is bun:sqlite's built-in helper:
  // it wraps the body in `BEGIN IMMEDIATE` / `COMMIT`, and rolls back +
  // rethrows on any throw inside. Replaces a manual try/catch.
  const applyOne = db.transaction((migration: Migration, appliedAt: string) => {
    db.exec(readFileSync(migration.path, 'utf8'));
    db.run('INSERT INTO meta (version, filename, applied_at) VALUES (?, ?, ?)', [
      migration.version,
      migration.filename,
      appliedAt,
    ]);
  });

  for (const migration of listMigrations(dir)) {
    if (applied.has(migration.version)) continue;

    const appliedAt = new Date().toISOString();
    applyOne.immediate(migration, appliedAt);

    ran.push({ version: migration.version, filename: migration.filename, applied_at: appliedAt });
  }

  return ran;
}

/**
 * Resolve the project's bundled `migrations/` directory. Works whether
 * the code runs from the source tree or after `bun install -g reviewdev`
 * — in both cases this file lives at `<root>/src/db/migrate.ts`.
 *
 * Uses `fileURLToPath(import.meta.url)` rather than Bun's `import.meta.dir`
 * because vitest's module transform doesn't surface the latter.
 */
export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}
