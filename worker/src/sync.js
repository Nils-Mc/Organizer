/**
 * Reconciling WebUntis data into local rows.
 *
 * The functions here are pure: they take what is already stored plus what Untis
 * just returned, and produce the list of writes. That keeps the two properties
 * that actually matter testable without a database:
 *
 *   1. Syncing twice changes nothing the second time (idempotence).
 *   2. Fields you own — a ticked-off homework, a note — are never overwritten.
 */

import {
  normalizeLesson, normalizeHomework, normalizeExam, indexById, encodeDate,
} from './untis.js';

/** Synced rows get deterministic ids, so an upsert needs no lookup table. */
export const idFor = {
  subject: (untisId) => `subj-${untisId}`,
  lesson: (untisId) => `les-${untisId}`,
  homework: (untisId) => `hw-${untisId}`,
  exam: (untisId) => `ex-${untisId}`,
};

/** Shallow equality over the fields a sync is allowed to touch. */
function changed(existing, next, fields) {
  if (!existing) return true;
  return fields.some((field) => {
    const a = existing[field];
    const b = next[field];
    if (a === null || a === undefined) return !(b === null || b === undefined);
    return String(a) !== String(b);
  });
}

/**
 * @template T
 * @param {{existing: Map<string, any>, rows: T[], fields: string[]}} input
 * @returns {{inserts: T[], updates: T[], unchanged: number}}
 */
function diffRows({ existing, rows, fields }) {
  const inserts = [];
  const updates = [];
  let unchanged = 0;

  for (const row of rows) {
    const current = existing.get(row.id);
    if (!current) inserts.push(row);
    else if (changed(current, row, fields)) updates.push(row);
    else unchanged++;
  }
  return { inserts, updates, unchanged };
}

const SUBJECT_FIELDS = ['name', 'long_name', 'color'];
const LESSON_FIELDS = ['subject_id', 'date', 'start_time', 'end_time', 'teachers', 'rooms', 'status', 'note'];
const HOMEWORK_FIELDS = ['subject_id', 'due_date', 'text'];
const EXAM_FIELDS = ['subject_id', 'due_date', 'start_time', 'end_time', 'name', 'text'];

export function reconcileSubjects(existingRows, untisSubjects, now) {
  const existing = new Map(existingRows.map((r) => [r.id, r]));
  const rows = (untisSubjects || []).map((s) => ({
    id: idFor.subject(s.id),
    untis_id: s.id,
    name: s.name,
    long_name: s.longName || null,
    // Untis ships a background colour per subject; reuse it so the UI matches.
    color: s.backColor ? `#${String(s.backColor).replace(/^#/, '')}` : null,
    created_at: now,
  }));
  return diffRows({ existing, rows, fields: SUBJECT_FIELDS });
}

export function reconcileLessons(existingRows, rawLessons, lookups, now) {
  const existing = new Map(existingRows.map((r) => [r.id, r]));
  const rows = (rawLessons || []).map((raw) => {
    const lesson = normalizeLesson(raw, lookups);
    return {
      id: idFor.lesson(lesson.untisId),
      untis_id: lesson.untisId,
      subject_id: lesson.subjectUntisId ? idFor.subject(lesson.subjectUntisId) : null,
      date: lesson.date,
      start_time: lesson.startTime,
      end_time: lesson.endTime,
      teachers: JSON.stringify(lesson.teachers),
      rooms: JSON.stringify(lesson.rooms),
      status: lesson.status,
      note: lesson.note,
      synced_at: now,
    };
  });
  return diffRows({ existing, rows, fields: LESSON_FIELDS });
}

/**
 * Homework is the one place where local state and remote state collide: you tick
 * a task off here, Untis still reports it open. Completion is therefore ours —
 * an existing row keeps its own `completed`, and only a brand-new row takes the
 * value Untis supplied.
 */
export function reconcileHomework(existingRows, rawHomework, lessonsByUntisId, now) {
  const existing = new Map(existingRows.map((r) => [r.id, r]));
  const rows = (rawHomework || []).map((raw) => {
    const hw = normalizeHomework(raw, lessonsByUntisId);
    const id = idFor.homework(hw.untisId);
    const current = existing.get(id);
    return {
      id,
      untis_id: hw.untisId,
      subject_id: hw.subjectUntisId ? idFor.subject(hw.subjectUntisId) : null,
      due_date: hw.dueDate,
      text: hw.text,
      completed: current ? current.completed : (hw.completed ? 1 : 0),
      synced_at: now,
    };
  });
  return diffRows({ existing, rows, fields: HOMEWORK_FIELDS });
}

export function reconcileExams(existingRows, rawExams, subjectsByUntisId, now) {
  const existing = new Map(existingRows.map((r) => [r.id, r]));
  const rows = (rawExams || []).map((raw) => {
    const exam = normalizeExam(raw, subjectsByUntisId);
    return {
      id: idFor.exam(exam.untisId),
      untis_id: exam.untisId,
      subject_id: exam.subjectUntisId ? idFor.subject(exam.subjectUntisId) : null,
      due_date: exam.dueDate,
      start_time: exam.startTime,
      end_time: exam.endTime,
      name: exam.name,
      text: exam.text,
      synced_at: now,
    };
  });
  return diffRows({ existing, rows, fields: EXAM_FIELDS });
}

/** The window a scheduled sync pulls: a bit of history, a good chunk of future. */
export function syncWindow(today, { daysBack = 7, daysForward = 28 } = {}) {
  const from = new Date(today);
  from.setDate(from.getDate() - daysBack);
  const to = new Date(today);
  to.setDate(to.getDate() + daysForward);
  return { from, to, fromEncoded: encodeDate(from), toEncoded: encodeDate(to) };
}

/**
 * Run a full sync. `db` is a small port (see db.js) so this can be driven by a
 * fake in tests and by D1 in production.
 */
export async function runSync({ client, db, now = new Date() }) {
  const stamp = now.toISOString();
  const { from, to } = syncWindow(now);

  await client.login();
  try {
    const [subjects, teachers, rooms] = await Promise.all([
      client.getSubjects(), client.getTeachers(), client.getRooms(),
    ]);

    const subjectPlan = reconcileSubjects(await db.allSubjects(), subjects, stamp);
    await db.upsertSubjects(subjectPlan);

    const lookups = {
      subjects: indexById(subjects),
      teachers: indexById(teachers),
      rooms: indexById(rooms),
    };

    const rawLessons = await client.getTimetable(from, to);
    const lessonPlan = reconcileLessons(await db.allLessons(), rawLessons, lookups, stamp);
    await db.upsertLessons(lessonPlan);

    // Homework references lessons, so it needs the normalized lessons first.
    const lessonsByUntisId = new Map(
      (rawLessons || []).map((raw) => [raw.id, normalizeLesson(raw, lookups)])
    );

    const [rawHomework, rawExams] = await Promise.all([
      client.getHomework(from, to), client.getExams(from, to),
    ]);

    const homeworkPlan = reconcileHomework(await db.allHomework(), rawHomework, lessonsByUntisId, stamp);
    await db.upsertHomework(homeworkPlan);

    const examPlan = reconcileExams(await db.allExams(), rawExams, indexById(subjects), stamp);
    await db.upsertExams(examPlan);

    await db.setSyncState('last_sync', stamp);

    return {
      at: stamp,
      subjects: summarize(subjectPlan),
      lessons: summarize(lessonPlan),
      homework: summarize(homeworkPlan),
      exams: summarize(examPlan),
    };
  } finally {
    // Always hand the session back, even if the sync blew up halfway.
    await client.logout().catch(() => {});
  }
}

const summarize = (plan) => ({
  inserted: plan.inserts.length,
  updated: plan.updates.length,
  unchanged: plan.unchanged,
});
