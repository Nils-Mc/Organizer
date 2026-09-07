/**
 * Unit tests for the DOM-free modules.
 *
 * Runs both in the browser (tests/test.html) and headlessly under Node
 * (`node tests/run.js`) — `report` is supplied by whichever runner loaded us.
 */
import { Store, parseTags, normalizeState, STORAGE_KEY } from '../web/js/store.js';
import {
  toISODate, daysUntil, dueBucket, filterByView, sortTasks,
  groupByDue, matchesSearch, countsFor, formatDue,
} from '../web/js/filters.js';

/** Minimal in-memory stand-in for the Storage interface. */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const FIXED_TODAY = new Date(2026, 8, 3); // 2026-09-03, local time
const offsetDate = (days) => {
  const d = new Date(FIXED_TODAY);
  d.setDate(d.getDate() + days);
  return toISODate(d);
};

export function runTests(report) {
  const eq = (actual, expected, name) =>
    report(name, JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const ok = (cond, name, detail = 'expected truthy') => report(name, !!cond, detail);

  // ---- parseTags ----------------------------------------------------
  eq(parseTags('Buy milk #home #Errands'), { title: 'Buy milk', tags: ['home', 'errands'] },
    'parseTags extracts and lowercases tags');
  eq(parseTags('Read #book #book'), { title: 'Read', tags: ['book'] },
    'parseTags de-duplicates');
  eq(parseTags('Plain title'), { title: 'Plain title', tags: [] },
    'parseTags leaves untagged titles alone');
  eq(parseTags('Fix issue#42'), { title: 'Fix issue#42', tags: [] },
    'parseTags ignores a mid-word hash');

  // ---- store CRUD ---------------------------------------------------
  {
    const store = new Store(new MemoryStorage());
    const project = store.addProject('Work');
    ok(project && project.id, 'addProject returns a project with an id');
    eq(store.addProject('   '), null, 'addProject rejects a blank name');

    const task = store.addTask({ title: 'Ship #v1', projectId: project.id, priority: 'high' });
    eq(task.title, 'Ship', 'addTask strips tags from the title');
    eq(task.tags, ['v1'], 'addTask stores parsed tags');
    eq(task.projectId, project.id, 'addTask honours the project');
    eq(store.addTask({ title: '  ' }), null, 'addTask rejects a blank title');

    eq(store.addTask({ title: 'Bad project', projectId: 'nope' }).projectId, null,
      'addTask nulls an unknown project id');
    eq(store.addTask({ title: 'Bad prio', priority: 'urgent' }).priority, 'normal',
      'addTask falls back to normal priority');
    eq(store.addTask({ title: 'Bad date', dueDate: '03/09/2026' }).dueDate, null,
      'addTask rejects a malformed due date');

    store.toggleTask(task.id);
    ok(store.getTask(task.id).done, 'toggleTask completes a task');
    ok(store.getTask(task.id).completedAt, 'completing stamps completedAt');
    store.toggleTask(task.id);
    eq(store.getTask(task.id).completedAt, null, 'reopening clears completedAt');

    store.updateTask(task.id, { title: 'Ship it #urgent' });
    eq(store.getTask(task.id).title, 'Ship it', 'updateTask rewrites the title');
    eq(store.getTask(task.id).tags, ['v1', 'urgent'], 'updateTask merges new tags');
  }

  // ---- delete / restore / project deletion ---------------------------
  {
    const store = new Store(new MemoryStorage());
    const a = store.addTask({ title: 'A' });
    const b = store.addTask({ title: 'B' });
    const c = store.addTask({ title: 'C' });
    const removed = store.deleteTask(b.id);
    eq(removed.index, 1, 'deleteTask reports the original index');
    eq(store.getTasks().map((t) => t.title), ['A', 'C'], 'deleteTask removes the task');
    store.restoreTask(removed.task, removed.index);
    eq(store.getTasks().map((t) => t.title), ['A', 'B', 'C'], 'restoreTask puts it back in place');
    ok(a && c, 'sibling tasks survive the round-trip');

    const project = store.addProject('Temp');
    store.updateTask(a.id, { projectId: project.id });
    store.deleteProject(project.id);
    eq(store.getTask(a.id).projectId, null, 'deleteProject returns its tasks to the Inbox');
    ok(store.getTask(a.id), 'deleteProject does not delete the tasks themselves');

    store.updateTask(c.id, { done: true });
    eq(store.clearCompleted(), 1, 'clearCompleted reports how many it removed');
    eq(store.getTasks().length, 2, 'clearCompleted keeps open tasks');
  }

  // ---- persistence ---------------------------------------------------
  {
    const storage = new MemoryStorage();
    const first = new Store(storage);
    const project = first.addProject('Home');
    first.addTask({ title: 'Water plants', projectId: project.id, dueDate: '2026-09-10' });

    const reloaded = new Store(storage); // simulates a page reload
    eq(reloaded.getTasks().length, 1, 'tasks survive a reload');
    eq(reloaded.getTasks()[0].title, 'Water plants', 'reloaded task keeps its title');
    eq(reloaded.getProjects()[0].name, 'Home', 'projects survive a reload');
    eq(reloaded.getTasks()[0].projectId, project.id, 'the project link survives a reload');

    storage.setItem(STORAGE_KEY, '{not json');
    eq(new Store(storage).getTasks(), [], 'corrupt storage degrades to an empty state');
  }

  // ---- import / export ------------------------------------------------
  {
    const source = new Store(new MemoryStorage());
    const project = source.addProject('Work');
    source.addTask({ title: 'One', projectId: project.id });
    source.addTask({ title: 'Two', dueDate: '2026-12-01', priority: 'high' });
    const json = source.exportJSON();

    const target = new Store(new MemoryStorage());
    target.importJSON(json, 'replace');
    eq(target.state, source.state, 'export/import round-trips the whole state');

    const merged = new Store(new MemoryStorage());
    merged.addTask({ title: 'Local' });
    const result = merged.importJSON(json, 'merge');
    eq(result, { projects: 1, tasks: 2 }, 'merge reports what it added');
    eq(merged.getTasks().length, 3, 'merge keeps existing tasks');
    merged.importJSON(json, 'merge');
    eq(merged.getTasks().length, 3, 'merging the same file twice adds nothing');

    const replaced = new Store(new MemoryStorage());
    replaced.addTask({ title: 'Gone' });
    replaced.importJSON(json, 'replace');
    eq(replaced.getTasks().map((t) => t.title), ['One', 'Two'], 'replace discards prior state');
  }

  // ---- normalizeState hardening ---------------------------------------
  {
    eq(normalizeState(null).tasks, [], 'normalizeState tolerates null');
    eq(normalizeState({ tasks: 'nope' }).tasks, [], 'normalizeState tolerates a bad tasks field');
    const state = normalizeState({
      tasks: [{ id: 't1', title: 'Keep' }, { id: 't2', title: '' }, null, 42],
    });
    eq(state.tasks.map((t) => t.title), ['Keep'], 'normalizeState drops malformed tasks');
    eq(state.tasks[0].priority, 'normal', 'normalizeState fills in defaults');
    eq(normalizeState({ tasks: [{ id: 'x', title: 'A' }, { id: 'x', title: 'B' }] }).tasks.length, 1,
      'normalizeState drops duplicate ids');
  }

  // ---- date buckets ----------------------------------------------------
  {
    const bucket = (days) => dueBucket({ dueDate: offsetDate(days) }, FIXED_TODAY);
    eq(dueBucket({ dueDate: null }, FIXED_TODAY), 'none', 'no due date -> none');
    eq(bucket(-5), 'overdue', 'past date -> overdue');
    eq(bucket(-1), 'overdue', 'yesterday -> overdue');
    eq(bucket(0), 'today', 'today -> today');
    eq(bucket(1), 'tomorrow', 'tomorrow -> tomorrow');
    eq(bucket(3), 'week', 'in three days -> week');
    eq(bucket(7), 'week', 'in seven days -> week');
    eq(bucket(8), 'later', 'in eight days -> later');
    eq(daysUntil(offsetDate(4), FIXED_TODAY), 4, 'daysUntil counts whole days');
    eq(daysUntil(offsetDate(-2), FIXED_TODAY), -2, 'daysUntil goes negative when overdue');
    eq(formatDue(offsetDate(0), FIXED_TODAY), 'Today', 'formatDue labels today');
    eq(formatDue(offsetDate(1), FIXED_TODAY), 'Tomorrow', 'formatDue labels tomorrow');
    eq(formatDue(offsetDate(-3), FIXED_TODAY), '3 days overdue', 'formatDue labels overdue');
  }

  // ---- views -----------------------------------------------------------
  {
    const tasks = [
      { id: '1', title: 'Overdue', done: false, dueDate: offsetDate(-2), priority: 'normal', projectId: 'p1', tags: [], notes: '', createdAt: '2026-01-01' },
      { id: '2', title: 'Today', done: false, dueDate: offsetDate(0), priority: 'high', projectId: null, tags: ['x'], notes: '', createdAt: '2026-01-02' },
      { id: '3', title: 'Soon', done: false, dueDate: offsetDate(2), priority: 'low', projectId: 'p1', tags: [], notes: '', createdAt: '2026-01-03' },
      { id: '4', title: 'Far', done: false, dueDate: offsetDate(30), priority: 'normal', projectId: null, tags: [], notes: 'later note', createdAt: '2026-01-04' },
      { id: '5', title: 'Done', done: true, dueDate: offsetDate(0), priority: 'normal', projectId: 'p1', tags: [], notes: '', createdAt: '2026-01-05' },
      { id: '6', title: 'Someday', done: false, dueDate: null, priority: 'normal', projectId: null, tags: [], notes: '', createdAt: '2026-01-06' },
    ];
    const titles = (view) => filterByView(tasks, view, FIXED_TODAY).map((t) => t.title);

    eq(titles('today'), ['Overdue', 'Today'], 'Today includes overdue tasks');
    eq(titles('upcoming'), ['Soon', 'Far'], 'Upcoming excludes today and overdue');
    eq(titles('completed'), ['Done'], 'Completed shows only finished tasks');
    eq(titles('all'), ['Overdue', 'Today', 'Soon', 'Far', 'Someday'], 'All shows every open task');
    eq(titles('inbox'), ['Today', 'Far', 'Someday'], 'Inbox shows unassigned open tasks');
    eq(titles('project:p1'), ['Overdue', 'Soon'], 'A project view excludes completed tasks');
    eq(titles('project:missing'), [], 'An unknown project view is empty');

    // sorting
    eq(sortTasks(tasks.filter((t) => !t.done), 'due').map((t) => t.title),
      ['Overdue', 'Today', 'Soon', 'Far', 'Someday'], 'due sort puts undated tasks last');
    eq(sortTasks(tasks.filter((t) => !t.done), 'priority').map((t) => t.title)[0], 'Today',
      'priority sort puts high first');
    eq(sortTasks(tasks.filter((t) => !t.done), 'created').map((t) => t.title)[0], 'Someday',
      'created sort is newest first');
    eq(sortTasks(tasks, 'title').map((t) => t.title)[0], 'Done', 'title sort is alphabetical');
    const original = tasks.map((t) => t.title);
    sortTasks(tasks, 'title');
    eq(tasks.map((t) => t.title), original, 'sortTasks does not mutate its input');

    // grouping
    eq(groupByDue(tasks.filter((t) => !t.done), FIXED_TODAY).map((g) => g.key),
      ['overdue', 'today', 'week', 'later', 'none'], 'groups are ordered and empty ones omitted');

    // search
    ok(matchesSearch(tasks[3], 'later'), 'search matches notes');
    ok(matchesSearch(tasks[1], 'x'), 'search matches tags');
    ok(matchesSearch(tasks[0], 'OVERD'), 'search is case-insensitive');
    ok(!matchesSearch(tasks[0], 'zzz'), 'search rejects a non-match');
    ok(matchesSearch(tasks[0], '   '), 'a blank query matches everything');

    // counts
    const counts = countsFor(tasks, [{ id: 'p1' }], FIXED_TODAY);
    eq(counts.today, 2, 'today count');
    eq(counts.upcoming, 2, 'upcoming count');
    eq(counts.all, 5, 'open count');
    eq(counts.completed, 1, 'completed count');
    eq(counts.inbox, 3, 'inbox count');
    eq(counts.projects.p1, 2, 'per-project count excludes completed');
  }
}
