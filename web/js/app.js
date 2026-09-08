/**
 * Entry point: restore preferences, bootstrap the store, wire up the UI.
 */
import { Store } from './store.js';
import { UI, applyAccent } from './ui.js';
import { School } from './school.js';

const PREFS_KEY = 'organizer.prefs.v1';

/** Small persisted key/value bag for view, sort and theme. */
const prefs = {
  data: (() => {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  })(),
  get(key) { return this.data[key]; },
  set(key, value) {
    this.data[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable — preferences simply won't persist */
    }
  },
};

// Everything visual is applied before first paint, so the app never appears in
// one style and then snaps into another.
if (prefs.get('theme')) document.documentElement.dataset.theme = prefs.get('theme');
applyAccent(prefs.get('accent'));
if (prefs.get('compact')) document.body.classList.add('is-compact');
if (prefs.get('animations') === false) document.body.classList.add('no-animations');

// The chosen start view wins on a fresh load; after that the last view sticks.
const startView = prefs.get('startView');
if (startView && startView !== 'last') prefs.set('view', startView);

const store = new Store();
const ui = new UI(store, prefs);

// Same reasoning as the theme: apply before first paint, not after, so the
// sidebar doesn't visibly snap from wide to collapsed on load.
if (prefs.get('sidebarCollapsed')) {
  ui.dom.sidebar.classList.add('collapsed');
  const toggle = document.getElementById('sidebar-collapse');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.title = 'Seitenleiste ausklappen';
  toggle.setAttribute('aria-label', toggle.title);
}

if (prefs.get('sort')) ui.dom.sort.value = prefs.get('sort');

store.subscribe(() => ui.render());
ui.render();

// Reflect edits made in another tab against the same storage.
window.addEventListener('storage', (event) => {
  if (event.key === 'organizer.v1') {
    store.state = store.load();
    ui.render();
  }
});

/**
 * The school panel is additive: it probes for a Worker backend and stays hidden
 * when there is none, so opening index.html straight from disk still gives the
 * original offline task app.
 */
const school = new School(document.getElementById('school-panel'), (msg) => ui.announce(msg));

// Feed the day plan with the school timetable, one-way. The task app never
// imports school.js — with no backend this hook simply keeps returning nothing
// and the day plan shows tasks only.
ui.lessonsForDay = (iso) =>
  ((school.state && school.state.lessons) || []).filter((lesson) => lesson.date === iso);

// Connection state and the sync action for the settings panel, same one-way
// arrangement — the settings page degrades to "not connected" without a backend.
ui.schoolState = () => ({ mode: school.mode, lastSync: school.state && school.state.lastSync });
ui.schoolSync = () => school.sync();

// School entries for the command palette, same one-way arrangement.
ui.extraCommands = () => {
  if (school.mode !== 'ready') return [];
  const go = (view) => () => {
    school.view = view;
    school.activeSubject = null;
    school.render();
    school.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const commands = [
    { label: 'Stundenplan', group: 'Schule', run: go('timetable') },
    { label: 'Fächer', group: 'Schule', run: go('subjects') },
    { label: 'Karteikarten', group: 'Schule', run: go('review') },
    { label: 'WebUntis synchronisieren', group: 'Schule', run: () => school.sync() },
  ];
  for (const subject of (school.state && school.state.subjects) || []) {
    commands.push({
      label: subject.long_name || subject.name,
      group: 'Fach',
      run: () => {
        school.view = 'subjects';
        school.activeSubject = subject;
        school.subjectData = null;
        school.render();
        school.loadSubject(subject.id);
        school.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    });
  }
  return commands;
};

school.init()
  .then(() => ui.render())
  .catch(() => { /* no backend — the task app is unaffected */ });

// Exposed for the end-to-end tests and for poking around in the console.
window.organizer = { store, ui, prefs, school };
