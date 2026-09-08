/**
 * Tests for sync reconciliation.
 *
 * The two properties worth defending: a second sync is a no-op, and anything
 * you edited locally survives it.
 */
import {
  reconcileSubjects, reconcileLessons, reconcileHomework, reconcileExams,
  syncWindow, runSync, idFor,
} from '../worker/src/sync.js';
import { indexById } from '../worker/src/untis.js';

const NOW = '2026-09-07T08:00:00.000Z';

const UNTIS_SUBJECTS = [
  { id: 7, name: 'M', longName: 'Mathematik', backColor: 'ff8800' },
  { id: 8, name: 'D', longName: 'Deutsch' },
];

const RAW_LESSONS = [
  { id: 55, date: 20260907, startTime: 800, endTime: 945, su: [{ id: 7 }], te: [{ id: 1 }], ro: [{ id: 3 }] },
  { id: 56, date: 20260907, startTime: 1000, endTime: 1045, su: [{ id: 8 }], code: 'cancelled', info: 'Entfall' },
];

const LOOKUPS = {
  subjects: indexById(UNTIS_SUBJECTS),
  teachers: indexById([{ id: 1, name: 'MUE' }]),
  rooms: indexById([{ id: 3, name: 'A12' }]),
};

/** In-memory stand-in for the D1 port. */
function fakeDb(seed = {}) {
  const tables = {
    subjects: [...(seed.subjects || [])],
    lessons: [...(seed.lessons || [])],
    homework: [...(seed.homework || [])],
    exams: [...(seed.exams || [])],
  };
  const state = new Map();
  const apply = (name) => (plan) => {
    for (const row of plan.inserts) tables[name].push({ ...row });
    for (const row of plan.updates) {
      const i = tables[name].findIndex((r) => r.id === row.id);
      if (i !== -1) tables[name][i] = { ...tables[name][i], ...row };
    }
  };
  return {
    tables,
    state,
    allSubjects: async () => tables.subjects,
    allLessons: async () => tables.lessons,
    allHomework: async () => tables.homework,
    allExams: async () => tables.exams,
    upsertSubjects: async (p) => apply('subjects')(p),
    upsertLessons: async (p) => apply('lessons')(p),
    upsertHomework: async (p) => apply('homework')(p),
    upsertExams: async (p) => apply('exams')(p),
    setSyncState: async (k, v) => state.set(k, v),
  };
}

/** Stand-in for UntisClient with the same surface runSync uses. */
function fakeClient(over = {}) {
  return {
    loggedOut: false,
    login: async () => ({ sessionId: 'S' }),
    logout: async function () { this.loggedOut = true; },
    getSubjects: async () => UNTIS_SUBJECTS,
    getTeachers: async () => [{ id: 1, name: 'MUE' }],
    getRooms: async () => [{ id: 3, name: 'A12' }],
    getTimetable: async () => RAW_LESSONS,
    getHomework: async () => [
      { id: 3, lessonId: 55, date: 20260907, dueDate: 20260914, text: 'S. 42', completed: false },
    ],
    getExams: async () => [
      { id: 9, subjectId: 7, examDate: 20261001, startTime: 800, endTime: 945, name: 'Klausur 1' },
    ],
    ...over,
  };
}

export function runSyncTests(report) {
  const eq = (actual, expected, name) =>
    report(name, JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const ok = (cond, name, detail = 'expected truthy') => report(name, !!cond, detail);

  // ---- subjects ---------------------------------------------------------
  {
    const first = reconcileSubjects([], UNTIS_SUBJECTS, NOW);
    eq(first.inserts.length, 2, 'first sync inserts both subjects');
    eq(first.updates.length, 0, 'first sync updates nothing');
    eq(first.inserts[0].id, 'subj-7', 'subject id derives from the Untis id');
    eq(first.inserts[0].color, '#ff8800', 'Untis colour carried across with a hash');
    eq(first.inserts[1].color, null, 'a subject without a colour stays null');

    const second = reconcileSubjects(first.inserts, UNTIS_SUBJECTS, NOW);
    eq(second.inserts.length, 0, 'second sync inserts nothing');
    eq(second.updates.length, 0, 'second sync updates nothing');
    eq(second.unchanged, 2, 'second sync sees both rows as unchanged');

    const renamed = reconcileSubjects(
      first.inserts,
      [{ ...UNTIS_SUBJECTS[0], longName: 'Mathe' }, UNTIS_SUBJECTS[1]],
      NOW
    );
    eq(renamed.updates.length, 1, 'a renamed subject produces one update');
    eq(renamed.updates[0].long_name, 'Mathe', 'the new name is in the update');
  }

  // ---- lessons ----------------------------------------------------------
  {
    const first = reconcileLessons([], RAW_LESSONS, LOOKUPS, NOW);
    eq(first.inserts.length, 2, 'both lessons inserted');
    eq(first.inserts[0].id, 'les-55', 'lesson id derives from the Untis id');
    eq(first.inserts[0].subject_id, 'subj-7', 'lesson links to its subject row');
    eq(first.inserts[0].teachers, '["MUE"]', 'teachers stored as JSON');
    eq(first.inserts[1].status, 'cancelled', 'cancelled status persisted');
    eq(first.inserts[1].note, 'Entfall', 'cancellation note persisted');

    eq(reconcileLessons(first.inserts, RAW_LESSONS, LOOKUPS, NOW).unchanged, 2,
      'a repeated lesson sync is a no-op');

    // A room change mid-week must land as an update, not a duplicate.
    const moved = reconcileLessons(
      first.inserts,
      [{ ...RAW_LESSONS[0], ro: [{ id: 4 }] }, RAW_LESSONS[1]],
      { ...LOOKUPS, rooms: indexById([{ id: 3, name: 'A12' }, { id: 4, name: 'B03' }]) },
      NOW
    );
    eq(moved.updates.length, 1, 'a room change is one update');
    eq(moved.inserts.length, 0, 'a room change does not insert a second lesson');
    eq(moved.updates[0].rooms, '["B03"]', 'the new room is in the update');
  }

  // ---- homework: local completion must win -------------------------------
  {
    const lessons = new Map([[55, { subjectUntisId: 7, subjectName: 'M' }]]);
    const raw = [{ id: 3, lessonId: 55, dueDate: 20260914, text: 'S. 42', completed: false }];

    const first = reconcileHomework([], raw, lessons, NOW);
    eq(first.inserts.length, 1, 'homework inserted on first sync');
    eq(first.inserts[0].completed, 0, 'a new homework takes the Untis completion flag');
    eq(first.inserts[0].subject_id, 'subj-7', 'homework linked to its subject');

    // You tick it off locally...
    const stored = [{ ...first.inserts[0], completed: 1 }];
    // ...and Untis still reports it open on the next sync.
    const second = reconcileHomework(stored, raw, lessons, NOW);
    eq(second.updates.length, 0, 'an unchanged homework produces no update');
    eq(second.unchanged, 1, 'the ticked-off homework is left alone');

    // Even when the text genuinely changes, completion stays ours.
    const edited = reconcileHomework(stored, [{ ...raw[0], text: 'S. 43' }], lessons, NOW);
    eq(edited.updates.length, 1, 'a changed homework text is an update');
    eq(edited.updates[0].completed, 1, 'local completion survives a text update');
    eq(edited.updates[0].text, 'S. 43', 'the new text is applied');
  }

  // ---- exams -------------------------------------------------------------
  {
    const raw = [{ id: 9, subjectId: 7, examDate: 20261001, startTime: 800, endTime: 945, name: 'Klausur 1' }];
    const first = reconcileExams([], raw, indexById(UNTIS_SUBJECTS), NOW);
    eq(first.inserts.length, 1, 'exam inserted');
    eq(first.inserts[0].id, 'ex-9', 'exam id derives from the Untis id');
    eq(first.inserts[0].due_date, '2026-10-01', 'exam date lands in due_date');
    eq(reconcileExams(first.inserts, raw, indexById(UNTIS_SUBJECTS), NOW).unchanged, 1,
      'a repeated exam sync is a no-op');
  }

  // ---- sync window --------------------------------------------------------
  {
    const w = syncWindow(new Date(2026, 8, 7));
    eq(w.fromEncoded, 20260831, 'window reaches a week back');
    eq(w.toEncoded, 20261005, 'window reaches four weeks forward');
    const narrow = syncWindow(new Date(2026, 8, 7), { daysBack: 0, daysForward: 1 });
    eq(narrow.fromEncoded, 20260907, 'window honours daysBack');
    eq(narrow.toEncoded, 20260908, 'window honours daysForward');
  }

  // ---- full run -----------------------------------------------------------
  return (async () => {
    const db = fakeDb();
    const client = fakeClient();
    const result = await runSync({ client, db, now: new Date('2026-09-07T08:00:00Z') });

    eq(result.subjects.inserted, 2, 'run inserts subjects');
    eq(result.lessons.inserted, 2, 'run inserts lessons');
    eq(result.homework.inserted, 1, 'run inserts homework');
    eq(result.exams.inserted, 1, 'run inserts exams');
    ok(client.loggedOut, 'run logs out afterwards');
    eq(db.state.get('last_sync'), '2026-09-07T08:00:00.000Z', 'run records the sync time');

    // The headline property: run it again, nothing moves.
    const again = await runSync({ client: fakeClient(), db, now: new Date('2026-09-07T09:00:00Z') });
    eq(again.subjects, { inserted: 0, updated: 0, unchanged: 2 }, 'second run leaves subjects alone');
    eq(again.lessons, { inserted: 0, updated: 0, unchanged: 2 }, 'second run leaves lessons alone');
    eq(again.homework, { inserted: 0, updated: 0, unchanged: 1 }, 'second run leaves homework alone');
    eq(again.exams, { inserted: 0, updated: 0, unchanged: 1 }, 'second run leaves exams alone');
    eq(db.tables.lessons.length, 2, 'no duplicate lessons after two runs');
    eq(db.tables.homework.length, 1, 'no duplicate homework after two runs');

    // A tick-off survives a subsequent sync end to end.
    db.tables.homework[0].completed = 1;
    await runSync({ client: fakeClient(), db, now: new Date('2026-09-07T10:00:00Z') });
    eq(db.tables.homework[0].completed, 1, 'a completed homework stays completed through a sync');

    // A failure mid-sync must still release the session.
    {
      const failing = fakeClient({ getTimetable: async () => { throw new Error('boom'); } });
      let threw = null;
      try {
        await runSync({ client: failing, db: fakeDb(), now: new Date('2026-09-07T11:00:00Z') });
      } catch (e) { threw = e; }
      ok(threw, 'a failing sync surfaces its error');
      ok(failing.loggedOut, 'a failing sync still logs out');
    }
  })();
}
