-- 001_initial.sql
--
-- Lays down the 10 data-model tables from the MVP design
-- (.claude/specs/review-dev-mvp/design.md#data-model) plus the indexes
-- listed under "Indexes (minimum viable)". The `meta` migration-tracker
-- table is not in this file — `src/db/migrate.ts` creates it before any
-- numbered migration runs, since its purpose is to record which numbered
-- files have already been applied.
--
-- Conventions for this and future migration files:
--   - Forward-only. No DROPs of existing data tables.
--   - Timestamps are TEXT in ISO 8601 with `T` separator and `Z` suffix.
--     SQL defaults use `strftime('%Y-%m-%dT%H:%M:%fZ','now')` so they match
--     what JavaScript's `Date.toISOString()` writes from `migrate.ts` and
--     T1.4 publish code. Plain `datetime('now')` would emit `YYYY-MM-DD HH:MM:SS`
--     (space, no `Z`) which mis-sorts under `ORDER BY` against the TS form.
--   - Booleans are INTEGER (0 / 1) with a CHECK constraint to the {0,1} set.
--   - String enums with known sets carry a CHECK constraint; columns whose
--     vocabulary is still in flux (`hunks.kind`, `sessions.kind`,
--     `hunks.confidence`) are left open until the spec wording settles.
--   - Foreign keys are declared explicitly; `migrate.ts` enables them
--     via `PRAGMA foreign_keys = ON` on every connection.
--   - "order" is reserved in SQL — quoted everywhere it appears as a
--     column name.

-- ---------------------------------------------------------------------
-- Pulls — one row per branch that has been published at least once.
-- ---------------------------------------------------------------------
CREATE TABLE pulls (
  id INTEGER PRIMARY KEY,
  branch TEXT NOT NULL UNIQUE,
  base TEXT NOT NULL,
  title TEXT,
  github_url TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------
-- Sessions — Claude Code sessions correlated to a pull by cwd + time.
-- Scoped to the PR (not a single revision); sessions span revisions.
-- ---------------------------------------------------------------------
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  transcript_path TEXT,
  cwd TEXT,
  started_at TEXT,
  ended_at TEXT,
  parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  compacted INTEGER NOT NULL DEFAULT 0 CHECK (compacted IN (0, 1))
);

-- ---------------------------------------------------------------------
-- Revisions — immutable snapshot per successful publish.
-- (pull_id, number) is unique; diff_hash detects duplicate publishes.
-- ---------------------------------------------------------------------
CREATE TABLE revisions (
  id INTEGER PRIMARY KEY,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  git_head_sha TEXT NOT NULL,
  git_base_sha TEXT NOT NULL,
  diff_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (pull_id, number)
);

-- ---------------------------------------------------------------------
-- Hunks — content-hashed diff segments scoped to a revision.
-- Same content-hash can recur across revisions (unchanged code), so the
-- primary key is composite (id, revision_id) per design.md.
-- ---------------------------------------------------------------------
CREATE TABLE hunks (
  id TEXT NOT NULL,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent TEXT,
  confidence TEXT NOT NULL DEFAULT 'high',
  generated INTEGER NOT NULL DEFAULT 0 CHECK (generated IN (0, 1)),
  PRIMARY KEY (id, revision_id)
);

CREATE INDEX hunks_revision_id ON hunks(revision_id);
CREATE INDEX hunks_pull_id ON hunks(pull_id);
CREATE INDEX hunks_file_path ON hunks(file_path);

-- ---------------------------------------------------------------------
-- Chapters — LLM-emitted story groupings of hunks within a revision.
-- inherited_from_chapter_id points at the prior revision's chapter when
-- the model reused it; drives the revision-diff chapter delta.
-- ---------------------------------------------------------------------
CREATE TABLE chapters (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  marker TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  "order" INTEGER NOT NULL,
  inherited_from_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL
);

CREATE INDEX chapters_revision_id ON chapters(revision_id);

-- ---------------------------------------------------------------------
-- chapter_hunks — many-to-many within a revision.
-- The FK to hunks is omitted at the SQLite level: hunks' PK is composite
-- and adding revision_id here for the composite FK would duplicate data
-- that chapter_id already carries. Application code enforces the
-- "hunk belongs to the chapter's revision" invariant.
-- ---------------------------------------------------------------------
CREATE TABLE chapter_hunks (
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  hunk_id TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  PRIMARY KEY (chapter_id, hunk_id)
);

CREATE INDEX chapter_hunks_chapter_id ON chapter_hunks(chapter_id);
CREATE INDEX chapter_hunks_hunk_id ON chapter_hunks(hunk_id);

-- ---------------------------------------------------------------------
-- Decisions — chronological annotations emitted alongside chapters in
-- the same LLM call.
-- ---------------------------------------------------------------------
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  ts TEXT NOT NULL,
  summary TEXT NOT NULL
);

-- ---------------------------------------------------------------------
-- Comments — markdown bodies scoped to a revision. No threading,
-- resolution, or line-anchoring in v1. target_kind / target_id pair
-- identifies what the comment hangs off (hunk / chapter / pr).
-- ---------------------------------------------------------------------
CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('hunk', 'chapter', 'pr')),
  target_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX comments_revision_target ON comments(revision_id, target_kind, target_id);

-- ---------------------------------------------------------------------
-- Approvals — chapter-level signoff on a specific revision.
-- ---------------------------------------------------------------------
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  note TEXT
);

-- ---------------------------------------------------------------------
-- Usage — one row per LLM call. Cost guardrails read sum-by-day from
-- here (soft warning at $5, hard cap via REVIEWDEV_DAILY_CAP).
-- ---------------------------------------------------------------------
CREATE TABLE usage (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  op TEXT NOT NULL
);

CREATE INDEX usage_day ON usage(day);
