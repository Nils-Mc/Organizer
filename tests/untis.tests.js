/**
 * Tests for the WebUntis client.
 *
 * No network: `fetch` is stubbed with recorded payload shapes, so these run
 * anywhere and stay deterministic.
 */
import {
  encodeDate, decodeDate, decodeTime, schoolCookieValue, lessonStatus,
  normalizeLesson, normalizeHomework, normalizeExam, indexById,
  UntisClient, UntisError,
} from '../worker/src/untis.js';

/** Records calls and replays queued responses, so we can assert on the request. */
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const next = queue.shift();
    if (!next) throw new Error('stubFetch: no queued response for ' + url);
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.json,
    };
  };
  return { fetch, calls };
}

const client = (over = {}) => new UntisClient({
  host: 'nessa.webuntis.com', school: 'mese', user: 'nils', password: 'pw', ...over,
});

export function runUntisTests(report) {
  const eq = (actual, expected, name) =>
    report(name, JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const ok = (cond, name, detail = 'expected truthy') => report(name, !!cond, detail);

  // ---- encodings -------------------------------------------------------
  eq(encodeDate(new Date(2026, 8, 7)), 20260907, 'encodeDate builds yyyyMMdd');
  eq(encodeDate(new Date(2026, 0, 5)), 20260105, 'encodeDate pads month and day');
  eq(decodeDate(20260907), '2026-09-07', 'decodeDate returns an ISO calendar day');
  eq(decodeDate('20260105'), '2026-01-05', 'decodeDate accepts a string');
  eq(decodeTime(830), '08:30', 'decodeTime pads a 3-digit morning time');
  eq(decodeTime(1430), '14:30', 'decodeTime handles an afternoon time');
  eq(decodeTime(5), '00:05', 'decodeTime pads a very small value');
  eq(schoolCookieValue('mese'), '_bWVzZQ==', 'schoolCookieValue base64s behind an underscore');

  // ---- lesson status ---------------------------------------------------
  eq(lessonStatus(undefined), 'regular', 'no code means a regular lesson');
  eq(lessonStatus('cancelled'), 'cancelled', 'cancelled maps through');
  eq(lessonStatus('irregular'), 'substitution', 'irregular means substitution');

  // ---- normalizeLesson -------------------------------------------------
  {
    const lookups = {
      subjects: indexById([{ id: 7, name: 'M' }, { id: 8, name: 'D' }]),
      teachers: indexById([{ id: 1, name: 'MUE' }, { id: 2, name: 'SCH' }]),
      rooms: indexById([{ id: 3, name: 'A12' }]),
    };
    const lesson = normalizeLesson({
      id: 55, date: 20260907, startTime: 800, endTime: 945,
      su: [{ id: 7 }], te: [{ id: 1 }], ro: [{ id: 3 }],
    }, lookups);

    eq(lesson.date, '2026-09-07', 'lesson date decoded');
    eq(lesson.startTime, '08:00', 'lesson start decoded');
    eq(lesson.endTime, '09:45', 'lesson end decoded');
    eq(lesson.subjectName, 'M', 'subject resolved through the lookup');
    eq(lesson.subjectUntisId, 7, 'subject id kept for upserts');
    eq(lesson.teachers, ['MUE'], 'teacher resolved');
    eq(lesson.rooms, ['A12'], 'room resolved');
    eq(lesson.status, 'regular', 'lesson without a code is regular');
    eq(lesson.note, null, 'no note when Untis sends none');

    const cancelled = normalizeLesson(
      { id: 56, date: 20260908, startTime: 1000, endTime: 1045, su: [{ id: 8 }], code: 'cancelled', info: 'Lehrer krank' },
      lookups
    );
    eq(cancelled.status, 'cancelled', 'cancelled lesson detected');
    eq(cancelled.note, 'Lehrer krank', 'info carried into the note');

    const substituted = normalizeLesson(
      { id: 57, date: 20260908, startTime: 1100, endTime: 1145, su: [{ id: 7 }], te: [{ id: 2 }], code: 'irregular', substText: 'Vertretung' },
      lookups
    );
    eq(substituted.status, 'substitution', 'substitution detected');
    eq(substituted.teachers, ['SCH'], 'substitute teacher resolved');

    // Robustness against the ragged edges of real payloads.
    const bare = normalizeLesson({ id: 58, date: 20260909, startTime: 900, endTime: 945 }, lookups);
    eq(bare.subjectName, null, 'missing subject does not throw');
    eq(bare.teachers, [], 'missing teachers become an empty list');
    const unknown = normalizeLesson(
      { id: 59, date: 20260909, startTime: 900, endTime: 945, su: [{ id: 999, name: 'PH' }] },
      lookups
    );
    eq(unknown.subjectName, 'PH', 'unknown subject id falls back to the inline name');
  }

  // ---- homework / exams -------------------------------------------------
  {
    const lessons = new Map([[55, { subjectUntisId: 7, subjectName: 'M' }]]);
    const hw = normalizeHomework(
      { id: 3, lessonId: 55, date: 20260907, dueDate: 20260914, text: '  S. 42 Nr. 3  ', completed: false },
      lessons
    );
    eq(hw.dueDate, '2026-09-14', 'homework due date decoded');
    eq(hw.subjectName, 'M', 'homework linked to its subject via the lesson');
    eq(hw.text, 'S. 42 Nr. 3', 'homework text trimmed');
    eq(hw.completed, false, 'homework completion carried over');

    const orphan = normalizeHomework({ id: 4, lessonId: 999, dueDate: 20260914, text: 'x' }, lessons);
    eq(orphan.subjectUntisId, null, 'homework for an unknown lesson has no subject');

    const exam = normalizeExam(
      { id: 9, subjectId: 7, examDate: 20261001, startTime: 800, endTime: 945, name: 'Klausur 1', text: 'Kapitel 1-3' },
      indexById([{ id: 7, name: 'M' }])
    );
    eq(exam.dueDate, '2026-10-01', 'exam date decoded into the same field tasks use');
    eq(exam.subjectName, 'M', 'exam subject resolved');
    eq(exam.startTime, '08:00', 'exam start decoded');
    eq(normalizeExam({ id: 10, examDate: 20261002 }, new Map()).name, 'Klausur',
      'exam without a name gets a sensible default');
  }

  // ---- indexById --------------------------------------------------------
  eq(indexById([{ id: 1, name: 'a' }]).get(1).name, 'a', 'indexById maps by id');
  eq(indexById(null).size, 0, 'indexById tolerates null');
  eq(indexById([null, { name: 'no id' }]).size, 0, 'indexById skips records without an id');

  // ---- client: login and session handling --------------------------------
  return (async () => {
    {
      const { fetch, calls } = stubFetch([
        { json: { result: { sessionId: 'SESSION123', personId: 42, personType: 5, klasseId: 7 } } },
        { json: { result: [{ id: 7, name: 'M', longName: 'Mathematik' }] } },
      ]);
      const c = client({ fetch });
      await c.login();

      eq(c.sessionId, 'SESSION123', 'login stores the session id');
      eq(c.personId, 42, 'login stores the person id');
      ok(calls[0].url.includes('/WebUntis/jsonrpc.do?school=mese'), 'login hits the JSON-RPC endpoint');
      eq(calls[0].body.method, 'authenticate', 'login calls authenticate');
      eq(calls[0].body.params.user, 'nils', 'login sends the username');
      ok(!calls[0].init.headers.cookie, 'no cookie is sent before a session exists');

      await c.getSubjects();
      eq(calls[1].init.headers.cookie, 'JSESSIONID=SESSION123; schoolname=_bWVzZQ==',
        'follow-up requests carry session and school cookies');
      eq(calls[1].body.method, 'getSubjects', 'getSubjects issues the right method');
    }

    // A login that returns no session must fail loudly, not silently half-work.
    {
      const { fetch } = stubFetch([{ json: { result: {} } }]);
      let threw = null;
      try { await client({ fetch }).login(); } catch (e) { threw = e; }
      ok(threw instanceof UntisError, 'a session-less login throws UntisError');
      ok(/check school, user and password/.test(threw.message), 'the error explains what to check');
    }

    // Protocol-level error inside a 200 response.
    {
      const { fetch } = stubFetch([
        { json: { error: { code: -8504, message: 'bad credentials' } } },
      ]);
      let threw = null;
      try { await client({ fetch }).login(); } catch (e) { threw = e; }
      ok(threw instanceof UntisError, 'a JSON-RPC error body throws');
      eq(threw.code, -8504, 'the Untis error code is preserved');
    }

    // Transport-level failure.
    {
      const { fetch } = stubFetch([{ ok: false, status: 503, json: {} }]);
      let threw = null;
      try { await client({ fetch }).login(); } catch (e) { threw = e; }
      ok(threw instanceof UntisError, 'a non-2xx response throws');
      eq(threw.code, 503, 'the HTTP status is preserved');
    }

    // Timetable request encodes its date range.
    {
      const { fetch, calls } = stubFetch([
        { json: { result: { sessionId: 'S', personId: 42, personType: 5 } } },
        { json: { result: [] } },
      ]);
      const c = client({ fetch });
      await c.login();
      await c.getTimetable(new Date(2026, 8, 7), new Date(2026, 8, 11));
      eq(calls[1].body.params.options.startDate, 20260907, 'timetable start encoded');
      eq(calls[1].body.params.options.endDate, 20260911, 'timetable end encoded');
      eq(calls[1].body.params.options.element, { id: 42, type: 5 },
        'timetable asks for the logged-in person');
    }

    // Homework/exams are REST, and their nesting varies between versions.
    {
      const { fetch, calls } = stubFetch([
        { json: { result: { sessionId: 'S', personId: 42, personType: 5, klasseId: 3 } } },
        { json: { data: { homeworks: [{ id: 1, lessonId: 55, dueDate: 20260914, text: 'a' }] } } },
        { json: { homeworks: [{ id: 2, lessonId: 55, dueDate: 20260915, text: 'b' }] } },
      ]);
      const c = client({ fetch });
      await c.login();

      const nested = await c.getHomework(new Date(2026, 8, 7), new Date(2026, 8, 14));
      eq(nested.length, 1, 'homework read from the nested "data" shape');
      ok(calls[1].url.includes('/WebUntis/api/homeworks/lessons'), 'homework uses the REST path');
      ok(calls[1].url.includes('startDate=20260907'), 'homework range encoded into the query');
      eq(calls[1].init.headers.cookie.startsWith('JSESSIONID=S'), true, 'REST calls send the session cookie');

      const flat = await c.getHomework(new Date(2026, 8, 7), new Date(2026, 8, 14));
      eq(flat.length, 1, 'homework also read from the flat shape');
    }

    // logout clears the session even when the call itself fails.
    {
      const { fetch } = stubFetch([
        { json: { result: { sessionId: 'S', personId: 1, personType: 5 } } },
        { ok: false, status: 500, json: {} },
      ]);
      const c = client({ fetch });
      await c.login();
      let threw = null;
      try { await c.logout(); } catch (e) { threw = e; }
      ok(threw, 'a failing logout still surfaces its error');
      eq(c.sessionId, null, 'the session is cleared even when logout fails');
    }
  })();
}
