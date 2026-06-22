import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migration system for the per-repo SQLite database.
 *
 * The `meta` table lives here (not in 001_initial.sql) because it's part
 * of the migration *system*, not the data model. Numbered migrations may
 * not assume the meta table exists; `applyMigrations` creates it first.
 *
 * See `.claude/specs/review-dev-mvp/design.md` for the data-model contract.
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

// `applied_at` is set by SQL DEFAULT so the timestamp matches the format
// every other column in 001_initial.sql writes (T separator, milliseconds,
// `Z` suffix — see the file header in 001_initial.sql for the rationale).
const META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    version INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`;

// Matches "001_initial.sql", "042_add_foo.sql" etc. Captures the version.
const MIGRATION_FILENAME = /^(\d+)_[A-Za-z0-9_-]+\.sql$/;

// Strips SQL line (`-- ...`) and block (`/* ... */`) comments so a
// comment-only or empty migration can be recognised as a no-op.
const SQL_COMMENT = /--[^\n]*|\/\*[\s\S]*?\*\//g;

// bun:sqlite's `db.exec` throws on a string with no executable statement
// ("SQL string mustn't be blank" / "Query contained no valid SQL statement").
// A migration file that is empty or comment-only is a legitimate no-op
// (placeholder, squash artifact); `applyMigrations` records it in `meta`
// and skips the exec rather than crashing the run on every start.
function hasExecutableSql(sql: string): boolean {
  return sql.replace(SQL_COMMENT, '').trim().length > 0;
}

/**
 * Open the per-repo SQLite database. Creates the file if missing, sets
 * WAL mode for concurrent reads alongside the publish-writer, and turns
 * on foreign-key enforcement (off by default in SQLite for legacy reasons).
 *
 * Pass `:memory:` for an ephemeral database in tests.
 */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

/**
 * List every numbered migration file in `dir`, sorted by version.
 * Files that don't match the `NNN_<slug>.sql` pattern are skipped silently.
 *
 * Throws a diagnostic error if two files share the same numeric version
 * (e.g. `001_a.sql` + `001_b.sql`). Without this guard the second file's
 * `INSERT INTO meta` would later fail with a raw `UNIQUE constraint failed:
 * meta.version` that names the meta table — not the two colliding files.
 */
export function listMigrations(dir: string): Migration[] {
  const sorted = readdirSync(dir)
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

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.version !== prev.version) continue;
    // Sort the two filenames so the diagnostic doesn't depend on the
    // readdir order (which is filesystem-dependent).
    const [a, b] = [prev.filename, curr.filename].sort();
    throw new Error(
      `migrate: duplicate migration version ${curr.version} in '${a}' and '${b}' (dir: ${dir})`,
    );
  }

  return sorted;
}

/**
 * Apply every migration in `dir` that hasn't already been recorded in
 * `meta`. Returns the migrations that ran on this call (empty list if
 * the DB was already up to date).
 *
 * Each migration runs inside its own `db.transaction(...).immediate(...)`.
 * If one fails midway, the transaction rolls back and the error propagates.
 * Earlier migrations stay applied. The file is read from disk *before*
 * `BEGIN IMMEDIATE` so the write lock is held only for the actual exec +
 * meta insert, not the I/O.
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
  // rethrows on any throw inside.
  const applyOne = db.transaction((migration: Migration, sql: string): AppliedMigration => {
    if (hasExecutableSql(sql)) db.exec(sql);
    const row = db
      .query<
        { applied_at: string },
        [number, string]
      >('INSERT INTO meta (version, filename) VALUES (?, ?) RETURNING applied_at')
      .get(migration.version, migration.filename)!;
    return { version: migration.version, filename: migration.filename, applied_at: row.applied_at };
  });

  for (const migration of listMigrations(dir)) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(migration.path, 'utf8');
    ran.push(applyOne.immediate(migration, sql));
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

/**
 * Highest applied migration version recorded in `meta`, or 0 before any
 * migration has run. Owned here alongside the rest of the `meta`-table contract
 * (callers shouldn't hand-write `SELECT MAX(version)`); `serve` surfaces it via
 * `/health`.
 */
export function currentVersion(db: Database): number {
  const row = db.query<{ v: number | null }, []>('SELECT MAX(version) AS v FROM meta').get();
  return row?.v ?? 0;
}

/**
 * Highest migration version bundled on disk in `dir` (0 if none). Compared
 * against `currentVersion` to detect a DB migrated by a newer binary than the
 * one bundling these files.
 */
export function latestMigrationVersion(dir: string): number {
  const all = listMigrations(dir);
  return all.length ? all[all.length - 1]!.version : 0;
}
