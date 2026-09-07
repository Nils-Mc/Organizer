/**
 * D1 adapter.
 *
 * Implements the small port that sync.js expects, plus the reads the API serves.
 * Kept deliberately thin: all the decision-making lives in sync.js, which is
 * pure and therefore testable without a database.
 */

const COLUMNS = {
  subjects: ['id', 'untis_id', 'name', 'long_name', 'color', 'created_at'],
  lessons: ['id', 'untis_id', 'subject_id', 'date', 'start_time', 'end_time',
    'teachers', 'rooms', 'status', 'note', 'synced_at'],
  homework: ['id', 'untis_id', 'subject_id', 'due_date', 'text', 'completed', 'synced_at'],
  exams: ['id', 'untis_id', 'subject_id', 'due_date', 'start_time', 'end_time',
    'name', 'text', 'synced_at'],
};

/** `INSERT .. ON CONFLICT(id) DO UPDATE` over a fixed column list. */
function upsertSql(table) {
  const cols = COLUMNS[table];
  const placeholders = cols.map(() => '?').join(', ');
  const assignments = cols
    .filter((c) => c !== 'id' && c !== 'created_at')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
          ON CONFLICT(id) DO UPDATE SET ${assignments}`;
}

export function createDb(D1) {
  const all = async (sql, ...params) => {
    const { results } = await D1.prepare(sql).bind(...params).all();
    return results || [];
  };

  const writeRows = async (table, plan) => {
    const rows = [...plan.inserts, ...plan.updates];
    if (!rows.length) return;
    const sql = upsertSql(table);
    const cols = COLUMNS[table];
    // One batch per table keeps a sync to a handful of round trips.
    await D1.batch(
      rows.map((row) => D1.prepare(sql).bind(...cols.map((c) => row[c] ?? null)))
    );
  };

  return {
    // -- the port sync.js uses -----------------------------------------
    allSubjects: () => all('SELECT * FROM subjects'),
    allLessons: () => all('SELECT * FROM lessons'),
    allHomework: () => all('SELECT * FROM homework'),
    allExams: () => all('SELECT * FROM exams'),
    upsertSubjects: (plan) => writeRows('subjects', plan),
    upsertLessons: (plan) => writeRows('lessons', plan),
    upsertHomework: (plan) => writeRows('homework', plan),
    upsertExams: (plan) => writeRows('exams', plan),
    setSyncState: (key, value) =>
      D1.prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                                updated_at = excluded.updated_at`)
        .bind(key, value, new Date().toISOString()).run(),
    getSyncState: async (key) => {
      const row = await D1.prepare('SELECT value FROM sync_state WHERE key = ?').bind(key).first();
      return row ? row.value : null;
    },

    // -- reads the API serves -------------------------------------------
    subjectsWithCounts: () => all(`
      SELECT s.*,
             (SELECT COUNT(*) FROM homework h
               WHERE h.subject_id = s.id AND h.completed = 0) AS open_homework,
             (SELECT COUNT(*) FROM notes n WHERE n.subject_id = s.id)     AS note_count,
             (SELECT COUNT(*) FROM materials m WHERE m.subject_id = s.id) AS material_count
        FROM subjects s
       ORDER BY s.name`),

    lessonsBetween: (from, to) => all(
      `SELECT l.*, s.name AS subject_name, s.color AS subject_color
         FROM lessons l LEFT JOIN subjects s ON s.id = l.subject_id
        WHERE l.date BETWEEN ? AND ?
        ORDER BY l.date, l.start_time`, from, to),

    openHomework: () => all(
      `SELECT h.*, s.name AS subject_name, s.color AS subject_color
         FROM homework h LEFT JOIN subjects s ON s.id = h.subject_id
        WHERE h.completed = 0 ORDER BY h.due_date IS NULL, h.due_date`),

    upcomingExams: (from) => all(
      `SELECT e.*, s.name AS subject_name, s.color AS subject_color
         FROM exams e LEFT JOIN subjects s ON s.id = e.subject_id
        WHERE e.due_date >= ? ORDER BY e.due_date`, from),

    setHomeworkCompleted: (id, completed) =>
      D1.prepare('UPDATE homework SET completed = ? WHERE id = ?')
        .bind(completed ? 1 : 0, id).run(),

    notesForSubject: (subjectId) => all(
      'SELECT * FROM notes WHERE subject_id = ? ORDER BY updated_at DESC', subjectId),

    createNote: (note) =>
      D1.prepare(`INSERT INTO notes (id, subject_id, lesson_id, title, body, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(note.id, note.subject_id, note.lesson_id ?? null, note.title,
              note.body, note.created_at, note.updated_at).run(),

    updateNote: (id, { title, body, updated_at }) =>
      D1.prepare('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?')
        .bind(title, body, updated_at, id).run(),

    deleteNote: (id) => D1.prepare('DELETE FROM notes WHERE id = ?').bind(id).run(),

    materialsForSubject: (subjectId) => all(
      'SELECT * FROM materials WHERE subject_id = ? ORDER BY created_at DESC', subjectId),

    createMaterial: (m) =>
      D1.prepare(`INSERT INTO materials
                    (id, subject_id, lesson_id, kind, filename, r2_key, mime,
                     size_bytes, chunk_index, chunk_group, status, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(m.id, m.subject_id, m.lesson_id ?? null, m.kind, m.filename, m.r2_key,
              m.mime ?? null, m.size_bytes ?? null, m.chunk_index ?? 0,
              m.chunk_group ?? null, m.status ?? 'stored', m.created_at).run(),

    setMaterialStatus: (id, status) =>
      D1.prepare('UPDATE materials SET status = ? WHERE id = ?').bind(status, id).run(),

    getMaterial: (id) =>
      D1.prepare('SELECT * FROM materials WHERE id = ?').bind(id).first(),

    saveTranscript: (t) =>
      D1.prepare(`INSERT INTO transcripts (id, material_id, text, language, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .bind(t.id, t.material_id, t.text, t.language ?? null, t.created_at).run(),

    transcriptFor: (materialId) =>
      D1.prepare('SELECT * FROM transcripts WHERE material_id = ?').bind(materialId).first(),

    saveSummary: (s) =>
      D1.prepare(`INSERT INTO summaries (id, target_type, target_id, model, body, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(s.id, s.target_type, s.target_id, s.model, s.body, s.created_at).run(),

    summariesFor: (targetType, targetId) => all(
      `SELECT * FROM summaries WHERE target_type = ? AND target_id = ?
        ORDER BY created_at DESC`, targetType, targetId),

    // -- search ----------------------------------------------------------
    indexDocument: async ({ refId, kind, subjectId, title, body }) => {
      await D1.prepare('DELETE FROM search_fts WHERE ref_id = ?').bind(refId).run();
      await D1.prepare(`INSERT INTO search_fts (body, title, kind, ref_id, subject_id)
                        VALUES (?, ?, ?, ?, ?)`)
        .bind(body, title, kind, refId, subjectId ?? null).run();
    },

    searchKeyword: (query, limit = 25) => all(
      `SELECT ref_id, kind, subject_id, title,
              snippet(search_fts, 0, '[', ']', '…', 12) AS snippet,
              bm25(search_fts) AS score
         FROM search_fts WHERE search_fts MATCH ?
        ORDER BY score LIMIT ?`, query, limit),
  };
}
