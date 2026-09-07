-- Organizer schema (D1 / SQLite).
--
-- Everything mirrored from WebUntis carries its `untis_id` and is reconciled by
-- upsert, so re-syncing never duplicates and never clobbers anything you wrote.
-- Content you own (notes, materials, summaries, flashcards) has no Untis id and
-- is never touched by a sync.

CREATE TABLE IF NOT EXISTS subjects (
  id           TEXT PRIMARY KEY,
  untis_id     INTEGER UNIQUE,
  name         TEXT NOT NULL,
  long_name    TEXT,
  color        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id           TEXT PRIMARY KEY,
  untis_id     INTEGER UNIQUE,
  subject_id   TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  date         TEXT NOT NULL,               -- local calendar day, YYYY-MM-DD
  start_time   TEXT NOT NULL,               -- HH:MM
  end_time     TEXT NOT NULL,
  teachers     TEXT,                        -- JSON array
  rooms        TEXT,                        -- JSON array
  status       TEXT NOT NULL DEFAULT 'regular',  -- regular | cancelled | substitution
  note         TEXT,
  synced_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lessons_by_date ON lessons(date);
CREATE INDEX IF NOT EXISTS lessons_by_subject ON lessons(subject_id);

CREATE TABLE IF NOT EXISTS homework (
  id           TEXT PRIMARY KEY,
  untis_id     INTEGER UNIQUE,
  subject_id   TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  due_date     TEXT,
  text         TEXT NOT NULL,
  -- Completion is ours, not Untis's: a local tick must survive the next sync.
  completed    INTEGER NOT NULL DEFAULT 0,
  synced_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS homework_by_due ON homework(due_date);

CREATE TABLE IF NOT EXISTS exams (
  id           TEXT PRIMARY KEY,
  untis_id     INTEGER UNIQUE,
  subject_id   TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  due_date     TEXT,
  start_time   TEXT,
  end_time     TEXT,
  name         TEXT NOT NULL,
  text         TEXT,
  synced_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS exams_by_due ON exams(due_date);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  lesson_id    TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',    -- Markdown
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_by_subject ON notes(subject_id);

CREATE TABLE IF NOT EXISTS materials (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  lesson_id    TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,               -- audio | document
  filename     TEXT NOT NULL,
  r2_key       TEXT NOT NULL UNIQUE,
  mime         TEXT,
  size_bytes   INTEGER,
  -- A long recording is uploaded as several chunks that transcribe separately.
  chunk_index  INTEGER NOT NULL DEFAULT 0,
  chunk_group  TEXT,
  status       TEXT NOT NULL DEFAULT 'stored',  -- stored | transcribing | done | failed
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS materials_by_subject ON materials(subject_id);
CREATE INDEX IF NOT EXISTS materials_by_group ON materials(chunk_group, chunk_index);

CREATE TABLE IF NOT EXISTS transcripts (
  id           TEXT PRIMARY KEY,
  material_id  TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  language     TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id           TEXT PRIMARY KEY,
  target_type  TEXT NOT NULL,               -- material | note | lesson | subject
  target_id    TEXT NOT NULL,
  model        TEXT NOT NULL,
  body         TEXT NOT NULL,               -- Markdown
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS summaries_by_target ON summaries(target_type, target_id);

CREATE TABLE IF NOT EXISTS flashcards (
  id            TEXT PRIMARY KEY,
  subject_id    TEXT REFERENCES subjects(id) ON DELETE CASCADE,
  source_type   TEXT,
  source_id     TEXT,
  front         TEXT NOT NULL,
  back          TEXT NOT NULL,
  -- SM-2 scheduling state.
  due_at        TEXT NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 0,
  ease          REAL NOT NULL DEFAULT 2.5,
  repetitions   INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flashcards_by_due ON flashcards(due_at);

-- Keyword half of the search. The semantic half lives in Vectorize.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  body,
  title,
  kind UNINDEXED,
  ref_id UNINDEXED,
  subject_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL
);
