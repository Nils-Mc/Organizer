/**
 * Persistence and CRUD for the organizer.
 *
 * Deliberately free of any DOM access so it can be exercised headlessly.
 * The whole state is rewritten on every mutation: a personal organizer never
 * holds enough data for anything cleverer to pay off.
 */

export const STORAGE_KEY = 'organizer.v1';
export const SCHEMA_VERSION = 1;
export const PRIORITIES = ['low', 'normal', 'high'];

const PROJECT_COLORS = [
  '#3b6ef5', '#c8342b', '#4a9c6d', '#b8720d',
  '#8a4fd0', '#0f8fa8', '#c2417f', '#5d6b7a',
];

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function emptyState() {
  return { version: SCHEMA_VERSION, projects: [], tasks: [] };
}

/**
 * A real wall-clock time, not merely two digits and a colon: `25:99` has the
 * right shape and does not exist, and a day plan sorted by it would place the
 * entry somewhere nonsensical rather than reject it.
 */
export function isClockTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Pull `#tag` tokens out of a title, returning the cleaned title and the tags. */
export function parseTags(rawTitle) {
  const tags = [];
  const title = String(rawTitle)
    .replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_match, lead, tag) => {
      const normalized = tag.toLowerCase();
      if (!tags.includes(normalized)) tags.push(normalized);
      return lead;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { title, tags };
}

const WEEKDAYS = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];

const PRIORITY_WORDS = {
  hoch: 'high', high: 'high', wichtig: 'high',
  normal: 'normal', mittel: 'normal',
  niedrig: 'low', low: 'low', egal: 'low',
};

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * Read a typed line like `Mathe lernen morgen 18:00 #schule !hoch` into the
 * fields it describes, returning the title with those tokens removed.
 *
 * `today` is a parameter, not `new Date()`, for the same reason it is
 * everywhere else here: a parser whose result depends on when the test runs is
 * a parser nobody can test.
 *
 * Ambiguity worth knowing about: `12.09.` and `12:09` both look like a pair of
 * numbers. A trailing dot makes it a date, a colon makes it a time, and
 * `18.00` is read as a time only because month 0 does not exist.
 */
export function parseQuickAdd(rawText, today = new Date()) {
  let text = String(rawText || '');
  let dueDate = null;
  let dueTime = null;
  let priority = null;

  const cut = (pattern, handler) => {
    let used = false;
    text = text.replace(pattern, (...args) => {
      if (used) return args[0]; // only the first mention counts
      const replacement = handler(...args);
      if (replacement === null) return args[0];
      used = true;
      return replacement;
    });
  };

  // Priority: !hoch / !normal / !niedrig
  cut(/(^|\s)!([\p{L}]+)/giu, (match, lead, word) => {
    const mapped = PRIORITY_WORDS[word.toLowerCase()];
    if (!mapped) return null;
    priority = mapped;
    return lead;
  });

  const dayAfter = (offset) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    d.setDate(d.getDate() + offset);
    return isoOf(d);
  };

  // Relative days
  cut(/(^|\s)(heute|morgen|übermorgen)(?=\s|$)/iu, (match, lead, word) => {
    const offsets = { heute: 0, morgen: 1, übermorgen: 2 };
    dueDate = dayAfter(offsets[word.toLowerCase()]);
    return lead;
  });

  // Weekday names resolve to the next such day; naming today means next week,
  // because "montag" on a Monday almost never means "in the next few minutes".
  if (!dueDate) {
    cut(/(^|\s)(sonntag|montag|dienstag|mittwoch|donnerstag|freitag|samstag)(?=\s|$)/iu,
      (match, lead, word) => {
        const target = WEEKDAYS.indexOf(word.toLowerCase());
        const ahead = (target - today.getDay() + 7) % 7 || 7;
        dueDate = dayAfter(ahead);
        return lead;
      });
  }

  // Explicit dates: 12.09. / 12.9. / 12.09.2026
  if (!dueDate) {
    cut(/(^|\s)(\d{1,2})\.(\d{1,2})\.(\d{4})?(?=\s|$)/u, (match, lead, d, m, y) => {
      const day = Number(d);
      const month = Number(m);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const year = y ? Number(y) : today.getFullYear();
      const date = new Date(year, month - 1, day);
      if (date.getMonth() !== month - 1) return null; // e.g. 31.02.
      // A bare day/month that already passed this year means next year.
      if (!y && isoOf(date) < isoOf(today)) date.setFullYear(year + 1);
      dueDate = isoOf(date);
      return lead;
    });
  }

  // Times: 18:00 / 18.00 / 18h
  cut(/(^|\s)(\d{1,2})(?::|\.)(\d{2})(?=\s|$)/u, (match, lead, h, m) => {
    const time = `${pad(Number(h))}:${m}`;
    if (!isClockTime(time)) return null;
    dueTime = time;
    return lead;
  });
  if (!dueTime) {
    cut(/(^|\s)(\d{1,2})\s?h(?=\s|$)/iu, (match, lead, h) => {
      const time = `${pad(Number(h))}:00`;
      if (!isClockTime(time)) return null;
      dueTime = time;
      return lead;
    });
  }

  // A time needs a day to sit on, so a bare "18:00" means today.
  if (dueTime && !dueDate) dueDate = isoOf(today);

  // Tags last, reusing the existing parser rather than a second copy of it.
  const { title, tags } = parseTags(text);

  return { title, tags, dueDate, dueTime, priority };
}

/**
 * Coerce anything loaded from storage or an import file into a valid state.
 * Unknown fields are dropped rather than trusted, and malformed records are
 * skipped instead of failing the whole load.
 */
export function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;

  const projectIds = new Set();
  if (Array.isArray(raw.projects)) {
    for (const p of raw.projects) {
      if (!p || typeof p !== 'object') continue;
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      if (!name) continue;
      const id = typeof p.id === 'string' && p.id ? p.id : uid();
      if (projectIds.has(id)) continue;
      projectIds.add(id);
      state.projects.push({
        id,
        name,
        color: typeof p.color === 'string' ? p.color : PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length],
        createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
      });
    }
  }

  const taskIds = new Set();
  if (Array.isArray(raw.tasks)) {
    for (const t of raw.tasks) {
      if (!t || typeof t !== 'object') continue;
      const title = typeof t.title === 'string' ? t.title.trim() : '';
      if (!title) continue;
      const id = typeof t.id === 'string' && t.id ? t.id : uid();
      if (taskIds.has(id)) continue;
      taskIds.add(id);
      const now = new Date().toISOString();
      const done = t.done === true;
      state.tasks.push({
        id,
        title,
        notes: typeof t.notes === 'string' ? t.notes : '',
        projectId: typeof t.projectId === 'string' && projectIds.has(t.projectId) ? t.projectId : null,
        done,
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) ? t.dueDate : null,
        // Optional clock time on the due day. Without it a task is "sometime
        // today" and sorts after everything that has a time.
        dueTime: isClockTime(t.dueTime) ? t.dueTime : null,
        priority: PRIORITIES.includes(t.priority) ? t.priority : 'normal',
        tags: Array.isArray(t.tags)
          ? [...new Set(t.tags.filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase()))]
          : [],
        // Manual drag-and-drop position. Falls back to the load order so tasks
        // written before this field existed keep the sequence they had.
        order: Number.isFinite(t.order) ? t.order : state.tasks.length,
        createdAt: typeof t.createdAt === 'string' ? t.createdAt : now,
        updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now,
        completedAt: done && typeof t.completedAt === 'string' ? t.completedAt : null,
      });
    }
  }

  return state;
}

export class Store {
  /** @param {Storage|null} storage injectable so tests can use a stub */
  constructor(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storage;
    this.listeners = new Set();
    this.state = this.load();
  }

  load() {
    if (!this.storage) return emptyState();
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      return raw ? normalizeState(JSON.parse(raw)) : emptyState();
    } catch {
      // Corrupt or unreadable storage must not brick the app.
      return emptyState();
    }
  }

  save() {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* quota exceeded or storage disabled — keep working in memory */
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  commit() {
    this.save();
    for (const fn of this.listeners) fn(this.state);
  }

  // -- projects --------------------------------------------------------
  getProjects() { return this.state.projects; }

  getProject(id) { return this.state.projects.find((p) => p.id === id) || null; }

  addProject(name) {
    const clean = String(name).trim();
    if (!clean) return null;
    const project = {
      id: uid(),
      name: clean,
      color: PROJECT_COLORS[this.state.projects.length % PROJECT_COLORS.length],
      createdAt: new Date().toISOString(),
    };
    this.state.projects.push(project);
    this.commit();
    return project;
  }

  renameProject(id, name) {
    const project = this.getProject(id);
    const clean = String(name).trim();
    if (!project || !clean) return null;
    project.name = clean;
    this.commit();
    return project;
  }

  /** Deleting a project returns its tasks to the Inbox rather than dropping them. */
  deleteProject(id) {
    const index = this.state.projects.findIndex((p) => p.id === id);
    if (index === -1) return false;
    this.state.projects.splice(index, 1);
    for (const task of this.state.tasks) {
      if (task.projectId === id) task.projectId = null;
    }
    this.commit();
    return true;
  }

  // -- tasks -----------------------------------------------------------
  getTasks() { return this.state.tasks; }

  getTask(id) { return this.state.tasks.find((t) => t.id === id) || null; }

  addTask({ title, projectId = null, dueDate = null, dueTime = null, priority = 'normal', notes = '', tags = [] }) {
    const parsed = parseTags(title);
    if (!parsed.title) return null;
    // Tags can arrive already extracted (the quick-add parser strips them out
    // of the title before this point), so both sources are merged.
    const allTags = [...new Set([...parsed.tags, ...tags.filter((t) => typeof t === 'string' && t)])];
    const now = new Date().toISOString();
    const task = {
      id: uid(),
      title: parsed.title,
      notes: String(notes),
      projectId: projectId && this.getProject(projectId) ? projectId : null,
      done: false,
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null,
      // A time without a day has nothing to anchor to, so it is dropped.
      dueTime: dueDate && isClockTime(dueTime) ? dueTime : null,
      priority: PRIORITIES.includes(priority) ? priority : 'normal',
      tags: allTags,
      order: this.state.tasks.length,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.state.tasks.push(task);
    this.commit();
    return task;
  }

  updateTask(id, patch) {
    const task = this.getTask(id);
    if (!task) return null;

    if (typeof patch.title === 'string') {
      const parsed = parseTags(patch.title);
      if (parsed.title) {
        task.title = parsed.title;
        if (parsed.tags.length) {
          task.tags = [...new Set([...task.tags, ...parsed.tags])];
        }
      }
    }
    if (typeof patch.notes === 'string') task.notes = patch.notes;
    if ('projectId' in patch) {
      task.projectId = patch.projectId && this.getProject(patch.projectId) ? patch.projectId : null;
    }
    if ('dueDate' in patch) {
      task.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate) ? patch.dueDate : null;
      // Clearing the day clears the time with it — 18:00 of nothing is not a
      // thing the day plan can place.
      if (!task.dueDate) task.dueTime = null;
    }
    if ('dueTime' in patch) {
      task.dueTime = task.dueDate && isClockTime(patch.dueTime) ? patch.dueTime : null;
    }
    if ('order' in patch && Number.isFinite(patch.order)) task.order = patch.order;
    if (PRIORITIES.includes(patch.priority)) task.priority = patch.priority;
    if (typeof patch.done === 'boolean') {
      task.done = patch.done;
      task.completedAt = patch.done ? new Date().toISOString() : null;
    }

    task.updatedAt = new Date().toISOString();
    this.commit();
    return task;
  }

  toggleTask(id) {
    const task = this.getTask(id);
    if (!task) return null;
    return this.updateTask(id, { done: !task.done });
  }

  /** Returns the removed task plus its index, so a delete can be undone. */
  deleteTask(id) {
    const index = this.state.tasks.findIndex((t) => t.id === id);
    if (index === -1) return null;
    const [task] = this.state.tasks.splice(index, 1);
    this.commit();
    return { task, index };
  }

  restoreTask(task, index) {
    const at = Math.max(0, Math.min(index, this.state.tasks.length));
    this.state.tasks.splice(at, 0, task);
    this.commit();
    return task;
  }

  clearCompleted() {
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter((t) => !t.done);
    const removed = before - this.state.tasks.length;
    if (removed) this.commit();
    return removed;
  }

  // -- import / export -------------------------------------------------
  exportJSON() {
    return JSON.stringify(this.state, null, 2);
  }

  /** @param {'replace'|'merge'} mode */
  importJSON(json, mode = 'replace') {
    const incoming = normalizeState(typeof json === 'string' ? JSON.parse(json) : json);

    if (mode === 'replace') {
      this.state = incoming;
      this.commit();
      return { projects: incoming.projects.length, tasks: incoming.tasks.length };
    }

    const projectIds = new Set(this.state.projects.map((p) => p.id));
    const taskIds = new Set(this.state.tasks.map((t) => t.id));
    let projects = 0;
    let tasks = 0;

    for (const project of incoming.projects) {
      if (projectIds.has(project.id)) continue;
      projectIds.add(project.id);
      this.state.projects.push(project);
      projects++;
    }
    for (const task of incoming.tasks) {
      if (taskIds.has(task.id)) continue;
      taskIds.add(task.id);
      this.state.tasks.push(task);
      tasks++;
    }

    this.commit();
    return { projects, tasks };
  }
}
