-- 002_chapters_order_unique.sql
--
-- Enforce one chapter set per revision at the schema level. A revision's
-- chapter `order` values are 1..N and must be unique within the revision.
-- T1.8's file-based writer already satisfies this; the index makes the T2.x
-- mistake of inserting a second (LLM) chapter set without clearing the first
-- fail loudly inside the write transaction, instead of silently doubling the
-- table of contents with two `§ 01` rows (PR #32 review, tracked in #33).
--
-- A UNIQUE INDEX rather than an ALTER TABLE constraint because SQLite can't add
-- a table constraint after creation. It subsumes 001's `chapters_revision_id`
-- for `WHERE revision_id = ?` (leading-column prefix), so that index is dropped.
-- "order" is quoted — it is reserved in SQL (see 001_initial.sql).

CREATE UNIQUE INDEX chapters_revision_order ON chapters (revision_id, "order");
DROP INDEX chapters_revision_id;
