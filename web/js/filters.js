/**
 * Pure query helpers: filtering, sorting and date bucketing.
 *
 * Every function that cares about "now" takes the reference date as an
 * argument, so the behaviour is deterministic and testable against a fixed
 * clock rather than the wall clock.
 */

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Local calendar date as `YYYY-MM-DD` (never UTC — due dates are local days). */
export function toISODate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseISODate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Whole days from `today` to `iso`; negative means overdue. */
export function daysUntil(iso, today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((parseISODate(iso) - start) / DAY_MS);
}

/**
 * Bucket a task by its due date.
 * @returns {'none'|'overdue'|'today'|'tomorrow'|'week'|'later'}
 */
export function dueBucket(task, today = new Date()) {
  if (!task.dueDate) return 'none';
  const delta = daysUntil(task.dueDate, today);
  if (delta < 0) return 'overdue';
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  if (delta <= 7) return 'week';
  return 'later';
}

export function formatDue(iso, today = new Date()) {
  const delta = daysUntil(iso, today);
  if (delta === 0) return 'Heute';
  if (delta === 1) return 'Morgen';
  if (delta === -1) return 'Gestern';
  if (delta < 0) return `${Math.abs(delta)} Tage überfällig`;
  if (delta <= 7) {
    return parseISODate(iso).toLocaleDateString('de-DE', { weekday: 'long' });
  }
  return parseISODate(iso).toLocaleDateString('de-DE', { month: 'short', day: 'numeric' });
}

/** Free-text match across title, notes and tags. */
export function matchesSearch(task, query) {
  const q = String(query).trim().toLowerCase();
  if (!q) return true;
  return (
    task.title.toLowerCase().includes(q) ||
    task.notes.toLowerCase().includes(q) ||
    task.tags.some((tag) => tag.includes(q))
  );
}

/**
 * Apply the active view to a task list.
 * @param {string} view 'today' | 'upcoming' | 'all' | 'completed' | `project:<id>`
 */
export function filterByView(tasks, view, today = new Date()) {
  if (view === 'completed') return tasks.filter((t) => t.done);

  const open = tasks.filter((t) => !t.done);

  if (view === 'today') {
    return open.filter((t) => ['overdue', 'today'].includes(dueBucket(t, today)));
  }
  if (view === 'upcoming') {
    return open.filter((t) => ['tomorrow', 'week', 'later'].includes(dueBucket(t, today)));
  }
  if (view === 'inbox') return open.filter((t) => t.projectId === null);
  if (view.startsWith('project:')) {
    const id = view.slice('project:'.length);
    return open.filter((t) => t.projectId === id);
  }
  return open; // 'all'
}

/** Non-mutating sort. Tasks without a due date always sort after dated ones. */
export function sortTasks(tasks, sortBy = 'due') {
  const copy = [...tasks];
  copy.sort((a, b) => {
    if (sortBy === 'due') {
      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    }
    if (sortBy === 'priority') {
      const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (rank !== 0) return rank;
      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate < b.dueDate ? -1 : 1;
      }
      return 0;
    }
    if (sortBy === 'title') {
      return a.title.localeCompare(b.title);
    }
    return b.createdAt.localeCompare(a.createdAt); // 'created' — newest first
  });
  return copy;
}

const GROUP_LABELS = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'This week',
  later: 'Later',
  none: 'No due date',
};

const GROUP_ORDER = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'];

/**
 * Split tasks into ordered, labelled date groups. Empty groups are omitted.
 * @returns {{key: string, label: string, tasks: object[]}[]}
 */
export function groupByDue(tasks, today = new Date()) {
  const buckets = new Map(GROUP_ORDER.map((key) => [key, []]));
  for (const task of tasks) buckets.get(dueBucket(task, today)).push(task);
  return GROUP_ORDER
    .filter((key) => buckets.get(key).length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], tasks: buckets.get(key) }));
}

/** Open/total counts per view, for the sidebar badges. */
export function countsFor(tasks, projects, today = new Date()) {
  const counts = {
    today: filterByView(tasks, 'today', today).length,
    upcoming: filterByView(tasks, 'upcoming', today).length,
    all: tasks.filter((t) => !t.done).length,
    inbox: tasks.filter((t) => !t.done && t.projectId === null).length,
    completed: tasks.filter((t) => t.done).length,
    projects: {},
  };
  for (const project of projects) {
    counts.projects[project.id] = tasks.filter((t) => !t.done && t.projectId === project.id).length;
  }
  return counts;
}
