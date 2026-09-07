/** Tests for timetable shaping. */
import {
  startOfWeek, weekRange, shiftWeeks, groupByDay, weekHighlights,
  weekLabel, upcomingToday, asDueItems, WEEKDAYS,
} from '../web/js/schedule.js';
import { toISODate } from '../web/js/filters.js';

// 2026-09-07 is a Monday; 09-09 a Wednesday; 09-13 the following Sunday.
const MONDAY = new Date(2026, 8, 7);
const WEDNESDAY = new Date(2026, 8, 9);
const SUNDAY = new Date(2026, 8, 13);

const lesson = (date, start, over = {}) => ({
  id: `l-${date}-${start}`, date, start_time: start, end_time: '09:45',
  status: 'regular', subject_name: 'M', ...over,
});

export function runScheduleTests(report) {
  const eq = (actual, expected, name) =>
    report(name, JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

  // ---- week boundaries ---------------------------------------------------
  eq(toISODate(startOfWeek(MONDAY)), '2026-09-07', 'Monday is its own week start');
  eq(toISODate(startOfWeek(WEDNESDAY)), '2026-09-07', 'midweek resolves back to Monday');
  eq(toISODate(startOfWeek(SUNDAY)), '2026-09-07',
    'Sunday belongs to the week that just ended, not the next one');
  eq(toISODate(startOfWeek(new Date(2026, 8, 14))), '2026-09-14', 'the next Monday starts a new week');

  eq(weekRange(WEDNESDAY), { from: '2026-09-07', to: '2026-09-11' }, 'a school week is Mon–Fri');
  eq(weekRange(WEDNESDAY, 7), { from: '2026-09-07', to: '2026-09-13' }, 'a full week can be requested');

  eq(toISODate(shiftWeeks(WEDNESDAY, 1)), '2026-09-14', 'shifting forward lands on the next Monday');
  eq(toISODate(shiftWeeks(WEDNESDAY, -1)), '2026-08-31', 'shifting back lands on the previous Monday');
  eq(toISODate(shiftWeeks(WEDNESDAY, 0)), '2026-09-07', 'shifting by zero normalises to Monday');

  // ---- grouping ------------------------------------------------------------
  {
    const lessons = [
      lesson('2026-09-09', '10:00'),
      lesson('2026-09-07', '08:00'),
      lesson('2026-09-07', '09:50'),
    ];
    const days = groupByDay(lessons, MONDAY);

    eq(days.length, 5, 'a school week has five day columns');
    eq(days.map((d) => d.label), WEEKDAYS.slice(0, 5), 'days are labelled Monday to Friday');
    eq(days[0].lessons.length, 2, 'Monday keeps both of its lessons');
    eq(days[0].lessons.map((l) => l.start_time), ['08:00', '09:50'],
      'lessons within a day are ordered by start time');
    eq(days[1].lessons.length, 0, 'an empty Tuesday is still present');
    eq(days[2].lessons.length, 1, 'Wednesday keeps its lesson');
    eq(days[4].date, '2026-09-11', 'the last column is Friday');
    eq(groupByDay([], MONDAY).every((d) => d.lessons.length === 0),
      true, 'a week with no lessons still renders five days');
    eq(groupByDay(null, MONDAY).length, 5, 'groupByDay tolerates null');
  }

  // ---- highlights ------------------------------------------------------------
  {
    const lessons = [
      lesson('2026-09-07', '08:00'),
      lesson('2026-09-07', '10:00', { status: 'cancelled' }),
      lesson('2026-09-08', '08:00', { status: 'substitution' }),
      lesson('2026-09-09', '08:00', { status: 'cancelled' }),
    ];
    const h = weekHighlights(lessons);
    eq(h.cancelled.length, 2, 'cancelled lessons counted');
    eq(h.substituted.length, 1, 'substitutions counted');
    eq(h.total, 4, 'total counted');
    eq(weekHighlights([]).total, 0, 'an empty week has no highlights');
  }

  // ---- labels -----------------------------------------------------------------
  eq(weekLabel(MONDAY), '7.–11. September', 'a week inside one month reads compactly');
  eq(weekLabel(new Date(2026, 8, 28)), '28. September – 2. Oktober',
    'a week spanning two months names both');

  // ---- what is still ahead today ------------------------------------------------
  {
    const lessons = [
      lesson('2026-09-07', '08:00', { end_time: '09:30' }),
      lesson('2026-09-07', '10:00', { end_time: '11:30' }),
      lesson('2026-09-08', '08:00', { end_time: '09:30' }),
    ];
    const at10 = new Date(2026, 8, 7, 10, 15);
    eq(upcomingToday(lessons, at10).map((l) => l.start_time), ['10:00'],
      'a lesson in progress still counts as ahead; a finished one does not');

    const at7 = new Date(2026, 8, 7, 7, 0);
    eq(upcomingToday(lessons, at7).length, 2, 'before school both lessons are ahead');

    const at20 = new Date(2026, 8, 7, 20, 0);
    eq(upcomingToday(lessons, at20).length, 0, 'after school nothing is ahead');
    eq(upcomingToday(lessons, new Date(2026, 8, 8, 7, 0)).length, 1,
      'only the current day is considered');
  }

  // ---- due items ------------------------------------------------------------------
  {
    const items = asDueItems({
      homework: [{ id: 'hw-1', text: 'S. 42', subject_name: 'M', subject_color: '#f80', due_date: '2026-09-14', completed: 1 }],
      exams: [{ id: 'ex-1', name: 'Klausur 1', subject_name: 'D', subject_color: null, due_date: '2026-10-01' }],
    });
    eq(items.length, 2, 'homework and exams merge into one list');
    eq(items[0].kind, 'homework', 'homework keeps its kind');
    eq(items[0].done, true, 'a completed homework maps to done');
    eq(items[1].kind, 'exam', 'exams keep their kind');
    eq(items[1].done, false, 'exams are never "done"');
    eq(items[0].dueDate, '2026-09-14', 'due dates carry the field the views bucket by');
    eq(asDueItems({}), [], 'no input yields no items');
  }
}
