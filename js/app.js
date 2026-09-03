/**
 * Entry point: restore preferences, bootstrap the store, wire up the UI.
 */
import { Store } from './store.js';
import { UI } from './ui.js';

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

// Apply the saved theme before first paint to avoid a flash of the wrong one.
if (prefs.get('theme')) document.documentElement.dataset.theme = prefs.get('theme');

const store = new Store();
const ui = new UI(store, prefs);

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

// Exposed for the end-to-end tests and for poking around in the console.
window.organizer = { store, ui, prefs };
