/**
 * Timetable shaping — pure, no DOM, no clock of its own.
 *
 * Everything takes the reference date as an argument for the same reason the
 * rest of the app does: a timetable that renders differently depending on when
 * the test runs is a timetable nobody can test.
 */

import { toISODate, parseISODate } from './filters.js';

export const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

/** Monday of the week containing `date`. Sunday belongs to the week just ended. */
export function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - weekday);
  return d;
}

/** `{from, to}` as ISO days for a week, `days` long from its Monday. */
export function weekRange(date, days = 5) {
  const from = startOfWeek(date);
  const to = new Date(from);
  to.setDate(to.getDate() + days - 1);
  return { from: toISODate(from), to: toISODate(to) };
}

export function shiftWeeks(date, delta) {
  const d = startOfWeek(date);
  d.setDate(d.getDate() + delta * 7);
  return d;
}

/**
 * Group lessons into consecutive days, including days that have none — an empty
 * Wednesday is information, and silently dropping it misaligns the whole week.
 */
export function groupByDay(lessons, weekStart, days = 5) {
  const byDate = new Map();
  for (const lesson of lessons || []) {
    if (!byDate.has(lesson.date)) byDate.set(lesson.date, []);
    byDate.get(lesson.date).push(lesson);
  }

  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + i);
    const iso = toISODate(day);
    const items = (byDate.get(iso) || []).slice()
      .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
    out.push({ date: iso, label: WEEKDAYS[i], lessons: items });
  }
  return out;
}

/**
 * Bucket homework and exams into the same days the grid renders, so a deadline
 * shows up on the day it is due rather than in a separate list somewhere below.
 *
 * `overflow` catches everything outside the visible week — overdue from an
 * earlier week, or due later. Those must stay reachable: a deadline that
 * silently disappears because you paged the week forward is worse than one
 * shown out of place.
 */
export function groupDueByDay(dueItems, weekStart, days = 5) {
  const byDate = new Map();
  for (const item of dueItems || []) {
    if (!item || !item.dueDate) continue;
    if (!byDate.has(item.dueDate)) byDate.set(item.dueDate, []);
    byDate.get(item.dueDate).push(item);
  }

  const byDay = [];
  const visible = new Set();
  for (let i = 0; i < days; i++) {
    const day = new Date(weekStart);
    day.setDate(day.getDate() + i);
    const iso = toISODate(day);
    visible.add(iso);
    // Exams before homework: a test outranks an assignment on the same day.
    const items = (byDate.get(iso) || []).slice()
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'exam' ? -1 : 1));
    byDay.push({ date: iso, label: WEEKDAYS[i], items });
  }

  const overflow = (dueItems || [])
    .filter((item) => item && item.dueDate && !visible.has(item.dueDate))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return { byDay, overflow };
}

/** What changed this week: the bits worth surfacing without reading the grid. */
export function weekHighlights(lessons) {
  const cancelled = (lessons || []).filter((l) => l.status === 'cancelled');
  const substituted = (lessons || []).filter((l) => l.status === 'substitution');
  return { cancelled, substituted, total: (lessons || []).length };
}

/** Human label for a week, e.g. "7.–11. September". */
export function weekLabel(weekStart, days = 5) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + days - 1);
  const month = (d) => d.toLocaleDateString('de-DE', { month: 'long' });
  if (weekStart.getMonth() === end.getMonth()) {
    return `${weekStart.getDate()}.–${end.getDate()}. ${month(end)}`;
  }
  return `${weekStart.getDate()}. ${month(weekStart)} – ${end.getDate()}. ${month(end)}`;
}

/** Lessons still ahead today, so "what's next" needs no scrolling. */
export function upcomingToday(lessons, now) {
  const iso = toISODate(now);
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return (lessons || [])
    .filter((l) => l.date === iso && String(l.end_time) > clock)
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
}

/** Merge homework and exams into one due-dated list the existing views can bucket. */
export function asDueItems({ homework = [], exams = [] }) {
  return [
    ...homework.map((h) => ({
      id: h.id,
      kind: 'homework',
      title: h.text,
      subject: h.subject_name,
      color: h.subject_color,
      dueDate: h.due_date,
      done: h.completed === 1 || h.completed === true,
    })),
    ...exams.map((e) => ({
      id: e.id,
      kind: 'exam',
      title: e.name,
      subject: e.subject_name,
      color: e.subject_color,
      dueDate: e.due_date,
      done: false,
    })),
  ];
}

export { toISODate, parseISODate };
