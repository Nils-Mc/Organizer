/**
 * WebUntis client.
 *
 * Runs server-side only: WebUntis sends no CORS headers, so a browser can never
 * call it directly. `fetch` is injectable so the whole module can be tested
 * against recorded fixtures without touching the network.
 *
 * Two encodings to be careful with:
 *   - dates are integers `yyyyMMdd`   (20260907)
 *   - times are integers `Hmm`/`HHmm` with NO leading zero (830 = 08:30)
 */

/** @param {Date} date */
export function encodeDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return Number(`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`);
}

/** `20260907` → `'2026-09-07'` (the local-calendar-day form the app already uses). */
export function decodeDate(value) {
  const s = String(value).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** `830` → `'08:30'`, `1430` → `'14:30'`. */
export function decodeTime(value) {
  const s = String(value).padStart(4, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

/** WebUntis wants the school name base64'd behind an underscore in a cookie. */
export function schoolCookieValue(school) {
  const b64 = typeof btoa === 'function'
    ? btoa(school)
    : Buffer.from(school, 'utf8').toString('base64');
  return `_${b64}`;
}

/**
 * A lesson's `code` carries its status: absent for a normal lesson, `cancelled`
 * when it is dropped, `irregular` when something was substituted.
 */
export function lessonStatus(code) {
  if (code === 'cancelled') return 'cancelled';
  if (code === 'irregular') return 'substitution';
  return 'regular';
}

/** WebUntis returns `[{id: 42}]`; resolve those against a lookup table. */
function resolveNames(refs, lookup) {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) => {
      const entry = lookup.get(ref && ref.id);
      // `orgid` marks the element this one replaced (the substituted-away teacher).
      return entry ? entry.name : null;
    })
    .filter(Boolean);
}

/**
 * Turn one raw timetable entry into the shape the app stores.
 * Pure — no network, no clock.
 */
export function normalizeLesson(raw, lookups = {}) {
  const subjects = lookups.subjects || new Map();
  const teachers = lookups.teachers || new Map();
  const rooms = lookups.rooms || new Map();

  const subjectRef = Array.isArray(raw.su) && raw.su.length ? raw.su[0] : null;
  const subject = subjectRef ? subjects.get(subjectRef.id) : null;

  return {
    untisId: raw.id,
    date: decodeDate(raw.date),
    startTime: decodeTime(raw.startTime),
    endTime: decodeTime(raw.endTime),
    subjectUntisId: subject ? subject.id : null,
    subjectName: subject ? subject.name : (subjectRef && subjectRef.name) || null,
    teachers: resolveNames(raw.te, teachers),
    rooms: resolveNames(raw.ro, rooms),
    status: lessonStatus(raw.code),
    // `substText` and `info` are where Untis puts "Vertretung", "Raumänderung" etc.
    note: [raw.substText, raw.info, raw.lstext].filter(Boolean).join(' · ') || null,
  };
}

/** Pure: map a raw homework record onto our task-shaped fields. */
export function normalizeHomework(raw, lessonsByUntisId = new Map()) {
  const lesson = lessonsByUntisId.get(raw.lessonId);
  return {
    untisId: raw.id,
    subjectUntisId: lesson ? lesson.subjectUntisId : null,
    subjectName: lesson ? lesson.subjectName : null,
    assignedDate: raw.date ? decodeDate(raw.date) : null,
    // `dueDate` is what the rest of the app sorts and buckets by.
    dueDate: raw.dueDate ? decodeDate(raw.dueDate) : null,
    text: typeof raw.text === 'string' ? raw.text.trim() : '',
    completed: raw.completed === true,
  };
}

/** Pure: map a raw exam record. */
export function normalizeExam(raw, subjectsByUntisId = new Map()) {
  const subject = raw.subjectId ? subjectsByUntisId.get(raw.subjectId) : null;
  return {
    untisId: raw.id,
    subjectUntisId: subject ? subject.id : (raw.subjectId ?? null),
    subjectName: subject ? subject.name : (raw.subject || null),
    dueDate: raw.examDate ? decodeDate(raw.examDate) : null,
    startTime: raw.startTime ? decodeTime(raw.startTime) : null,
    endTime: raw.endTime ? decodeTime(raw.endTime) : null,
    name: (raw.name || raw.examType || 'Klausur').trim(),
    text: typeof raw.text === 'string' ? raw.text.trim() : '',
  };
}

export class UntisError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UntisError';
    this.code = code;
  }
}

export class UntisClient {
  /**
   * @param {{host: string, school: string, user: string, password: string,
   *          fetch?: typeof fetch}} config
   */
  constructor(config) {
    this.host = config.host;
    this.school = config.school;
    this.user = config.user;
    this.password = config.password;
    // globalThis.fetch's native implementation is bound to that global — passed
    // around and called as `this.fetch(...)` unbound, Workers throws "Illegal
    // invocation" rather than silently working like it does in Node.
    this.fetch = config.fetch || globalThis.fetch.bind(globalThis);
    this.sessionId = null;
    this.personId = null;
    this.personType = null;
    this.klasseId = null;
  }

  get origin() {
    return `https://${this.host}`;
  }

  cookieHeader() {
    if (!this.sessionId) return '';
    return `JSESSIONID=${this.sessionId}; schoolname=${schoolCookieValue(this.school)}`;
  }

  /** One JSON-RPC call. Throws UntisError on a transport or protocol error. */
  async rpc(method, params = {}) {
    const url = `${this.origin}/WebUntis/jsonrpc.do?school=${encodeURIComponent(this.school)}`;
    const headers = { 'content-type': 'application/json' };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;

    const response = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'organizer', jsonrpc: '2.0', method, params }),
    });

    if (!response.ok) {
      throw new UntisError(`WebUntis HTTP ${response.status} on ${method}`, response.status);
    }

    const payload = await response.json();
    if (payload && payload.error) {
      throw new UntisError(
        `WebUntis error on ${method}: ${payload.error.message}`,
        payload.error.code
      );
    }
    return payload ? payload.result : null;
  }

  /** REST call (homework and exams live outside JSON-RPC). */
  async rest(path, params = {}) {
    const url = new URL(`${this.origin}/WebUntis/api/${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await this.fetch(url.toString(), {
      headers: { cookie: this.cookieHeader(), accept: 'application/json' },
    });
    if (!response.ok) {
      throw new UntisError(`WebUntis HTTP ${response.status} on ${path}`, response.status);
    }
    return response.json();
  }

  async login() {
    const result = await this.rpc('authenticate', {
      user: this.user,
      password: this.password,
      client: 'organizer',
    });
    if (!result || !result.sessionId) {
      throw new UntisError('WebUntis did not return a session — check school, user and password.');
    }
    this.sessionId = result.sessionId;
    this.personId = result.personId;
    this.personType = result.personType;
    this.klasseId = result.klasseId;
    return result;
  }

  async logout() {
    if (!this.sessionId) return;
    try {
      await this.rpc('logout');
    } finally {
      // A failed logout must never mask the real error from the work above.
      this.sessionId = null;
    }
  }

  getSubjects() { return this.rpc('getSubjects'); }
  getTeachers() { return this.rpc('getTeachers'); }
  getRooms() { return this.rpc('getRooms'); }
  getHolidays() { return this.rpc('getHolidays'); }

  /** Timetable for the logged-in person between two Dates. */
  getTimetable(from, to) {
    return this.rpc('getTimetable', {
      options: {
        element: { id: this.personId, type: this.personType },
        startDate: encodeDate(from),
        endDate: encodeDate(to),
        showInfo: true,
        showSubstText: true,
        showLsText: true,
        klasseFields: ['id', 'name'],
        subjectFields: ['id', 'name'],
        teacherFields: ['id', 'name'],
        roomFields: ['id', 'name'],
      },
    });
  }

  async getHomework(from, to) {
    const data = await this.rest('homeworks/lessons', {
      startDate: encodeDate(from),
      endDate: encodeDate(to),
    });
    // The payload nests differently across WebUntis versions; accept both.
    const raw = (data && data.data) || data || {};
    return raw.homeworks || [];
  }

  async getExams(from, to) {
    try {
      const data = await this.rest('exams', {
        startDate: encodeDate(from),
        endDate: encodeDate(to),
        klasseId: this.klasseId ?? 0,
        withGrades: false,
      });
      const raw = (data && data.data) || data || {};
      return raw.exams || [];
    } catch (error) {
      // Some WebUntis accounts (student logins in particular) don't have rights
      // on this endpoint at all and get a flat 403 — that is not a sync failure,
      // just an account without exam data to sync.
      if (error instanceof UntisError && error.code === 403) return [];
      throw error;
    }
  }
}

/** Build id→record lookups once per sync. */
export function indexById(records) {
  const map = new Map();
  for (const record of records || []) {
    if (record && record.id != null) map.set(record.id, record);
  }
  return map;
}
