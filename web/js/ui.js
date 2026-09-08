/**
 * Rendering and DOM event wiring. The only module that touches the document.
 */
import { PRIORITIES, parseQuickAdd } from './store.js';
import {
  filterByView, sortTasks, groupByDue, matchesSearch,
  countsFor, formatDue, toISODate, dayPlan, formatDayHeading,
} from './filters.js';

const VIEWS = [
  { id: 'today', label: 'Heute', icon: '☀' },
  { id: 'upcoming', label: 'Demnächst', icon: '▸' },
  { id: 'all', label: 'Alle offenen', icon: '≡' },
  { id: 'inbox', label: 'Eingang', icon: '✉' },
  { id: 'completed', label: 'Erledigt', icon: '✓' },
];

const el = (id) => document.getElementById(id);

/**
 * Score a command against a typed query using subsequence matching: the typed
 * characters must appear in order but need not be adjacent, so "hut" finds
 * "Heute" and "erle" finds "Erledigt". Contiguous runs and matches at a word
 * start score higher, which is what makes short queries land on the obvious
 * command rather than an incidental one.
 *
 * Returns -1 when the query does not fit at all.
 */
export function commandScore(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();

  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    const at = t.indexOf(char, from);
    if (at === -1) return -1;
    if (at === previous + 1) score += 3;            // contiguous
    if (at === 0 || /[\s·—-]/.test(t[at - 1])) score += 2; // start of a word
    score += 1;
    previous = at;
    from = at + 1;
  }
  // Shorter targets win ties: an exact-ish hit beats a long string that merely
  // happens to contain the letters.
  return score * 100 - t.length;
}

export class UI {
  constructor(store, prefs) {
    this.store = store;
    this.prefs = prefs;
    this.editingId = null;
    this.undo = null;
    this.undoTimer = null;
    // Lessons for the day plan, supplied by app.js once the school panel has
    // loaded. A plain hook rather than an import: the task half has to keep
    // working with no backend at all, and must not depend on school.js.
    this.lessonsForDay = () => [];

    this.dom = {
      viewList: el('view-list'),
      projectList: el('project-list'),
      viewTitle: el('view-title'),
      viewSummary: el('view-summary'),
      container: el('task-container'),
      search: el('search'),
      sort: el('sort'),
      form: el('new-task-form'),
      title: el('new-task-title'),
      due: el('new-task-due'),
      time: el('new-task-time'),
      priority: el('new-task-priority'),
      project: el('new-task-project'),
      sidebar: el('sidebar'),
      toast: el('toast'),
      toastText: el('toast-text'),
      toastAction: el('toast-action'),
      live: el('live-region'),
      palette: el('palette'),
      paletteInput: el('palette-input'),
      paletteList: el('palette-list'),
      shortcuts: el('shortcuts'),
    };

    // Extra palette entries contributed by the school panel, injected by
    // app.js for the same reason as lessonsForDay: no import, no hard
    // dependency on a backend being there.
    this.extraCommands = () => [];
    this.paletteIndex = 0;

    this.bind();
  }

  // -- helpers ---------------------------------------------------------
  announce(message) { this.dom.live.textContent = message; }

  get today() { return new Date(); }

  button(className, label, dataset) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    Object.assign(b.dataset, dataset);
    return b;
  }

  // -- events ----------------------------------------------------------
  bind() {
    const d = this.dom;

    d.form.addEventListener('submit', (event) => {
      event.preventDefault();
      // What was typed wins over the pickers, which stay as the explicit way
      // to set a field the text did not mention.
      const parsed = parseQuickAdd(d.title.value, this.today);
      const task = this.store.addTask({
        title: parsed.title,
        tags: parsed.tags,
        dueDate: parsed.dueDate || d.due.value || null,
        dueTime: parsed.dueTime || d.time.value || null,
        priority: parsed.priority || d.priority.value,
        projectId: d.project.value || null,
      });
      if (!task) return;
      d.title.value = '';
      d.due.value = '';
      d.time.value = '';
      d.title.focus();

      // A task with no due date added from "Today" would otherwise be filed
      // correctly and then vanish, which reads as if nothing happened. Fall
      // back to a view that actually contains it.
      // The store's own subscriber has already re-rendered by now, so switching
      // the view here needs its own render to take effect.
      const view = this.resolveView();
      if (!filterByView([task], view, this.today).length) {
        this.prefs.set('view', 'all');
        this.render();
      }
      this.announce(`${task.title} hinzugefügt`);
    });

    d.search.addEventListener('input', () => this.render());
    d.sort.addEventListener('change', () => {
      this.prefs.set('sort', d.sort.value);
      this.render();
    });

    d.viewList.addEventListener('click', (e) => this.onViewClick(e));
    d.projectList.addEventListener('click', (e) => this.onViewClick(e));
    d.container.addEventListener('click', (e) => this.onTaskClick(e));
    d.container.addEventListener('change', (e) => this.onTaskChange(e));

    // Drag and drop, delegated like every other task interaction. render()
    // rebuilds the whole container, so nothing may rely on node identity
    // surviving — only the ids carried in the dataset.
    d.container.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.task');
      if (!row) return;
      this.draggingId = row.dataset.id;
      row.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag without payload.
      e.dataTransfer.setData('text/plain', row.dataset.id);
    });

    d.container.addEventListener('dragover', (e) => {
      if (!this.draggingId) return;
      const row = e.target.closest('.task');
      if (!row || row.dataset.id === this.draggingId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      for (const other of d.container.querySelectorAll('.drop-target')) {
        other.classList.remove('drop-target');
      }
      row.classList.add('drop-target');
    });

    d.container.addEventListener('drop', (e) => {
      const row = e.target.closest('.task');
      if (!this.draggingId || !row) return;
      e.preventDefault();
      const moved = this.store.reorderTask(this.draggingId, row.dataset.id);
      this.draggingId = null;
      if (!moved) return;
      // Any other sort rule would immediately overwrite what was just dragged,
      // so a drop is also a switch to manual ordering.
      if (d.sort.value !== 'manual') {
        d.sort.value = 'manual';
        this.prefs.set('sort', 'manual');
      }
      this.announce('Reihenfolge geändert');
      this.render();
    });

    d.container.addEventListener('dragend', () => {
      this.draggingId = null;
      for (const row of d.container.querySelectorAll('.is-dragging, .drop-target')) {
        row.classList.remove('is-dragging', 'drop-target');
      }
    });
    d.container.addEventListener('dblclick', (e) => {
      const title = e.target.closest('.task-title');
      if (title) this.startEdit(title.closest('.task').dataset.id);
    });

    el('add-project').addEventListener('click', () => {
      const name = prompt('Name des Projekts');
      if (!name) return;
      const project = this.store.addProject(name);
      if (project) {
        this.prefs.set('view', `project:${project.id}`);
        this.render();
      }
    });

    el('menu-toggle').addEventListener('click', (e) => {
      const open = d.sidebar.classList.toggle('open');
      e.currentTarget.setAttribute('aria-expanded', String(open));
    });

    el('sidebar-collapse').addEventListener('click', (e) => {
      const collapsed = d.sidebar.classList.toggle('collapsed');
      e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
      e.currentTarget.title = collapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen';
      e.currentTarget.setAttribute('aria-label', e.currentTarget.title);
      this.prefs.set('sidebarCollapsed', collapsed);
    });

    el('theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      this.prefs.set('theme', next);
    });

    el('export-btn').addEventListener('click', () => this.exportData());
    el('import-btn').addEventListener('click', () => el('import-file').click());
    el('import-file').addEventListener('change', (e) => this.importData(e));

    d.toastAction.addEventListener('click', () => this.performUndo());

    d.paletteInput.addEventListener('input', () => this.renderPalette());
    d.paletteInput.addEventListener('keydown', (e) => this.onPaletteKeydown(e));
    d.paletteList.addEventListener('click', (e) => {
      const row = e.target.closest('[data-command]');
      if (row) this.runCommand(Number(row.dataset.command));
    });
    // Clicking the backdrop, which is the dialog element itself outside its
    // content box, closes the palette.
    d.palette.addEventListener('click', (e) => {
      if (e.target === d.palette) d.palette.close();
    });
    for (const button of document.querySelectorAll('[data-close-sheet]')) {
      button.addEventListener('click', (e) => e.target.closest('dialog').close());
    }

    document.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  onKeydown(event) {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
    const meta = event.metaKey || event.ctrlKey;

    // Command palette — deliberately ahead of the modifier guard below, which
    // otherwise swallows every combination.
    if (meta && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.openPalette();
      return;
    }

    // Ctrl/Cmd+Enter submits whatever is being written.
    if (meta && event.key === 'Enter') {
      if (this.editingId) {
        const input = this.dom.container.querySelector('.edit-input');
        if (input) {
          event.preventDefault();
          this.commitEdit(this.editingId, input.value);
        }
        return;
      }
      if (this.dom.title.value.trim()) {
        event.preventDefault();
        this.dom.form.requestSubmit();
      }
      return;
    }

    if (event.key === 'Escape') {
      if (this.editingId) {
        this.editingId = null;
        this.render();
      } else if (typing && event.target === this.dom.search) {
        this.dom.search.value = '';
        this.render();
      }
      return;
    }
    if (typing || meta || event.altKey) return;

    if (event.key === 'n') {
      event.preventDefault();
      this.dom.title.focus();
    } else if (event.key === '/') {
      event.preventDefault();
      this.dom.search.focus();
    } else if (event.key === '?') {
      event.preventDefault();
      this.dom.shortcuts.showModal();
    }
  }

  // -- command palette ---------------------------------------------------
  /**
   * Everything reachable by name. Built fresh on open so it always reflects
   * the current projects and whatever the school panel currently offers.
   */
  commands() {
    const list = VIEWS.map((view) => ({
      label: view.label,
      group: 'Ansicht',
      run: () => { this.prefs.set('view', view.id); this.render(); },
    }));

    for (const project of this.store.getProjects()) {
      list.push({
        label: project.name,
        group: 'Projekt',
        run: () => { this.prefs.set('view', `project:${project.id}`); this.render(); },
      });
    }

    list.push(
      { label: 'Neue Aufgabe', group: 'Aktion', run: () => this.dom.title.focus() },
      { label: 'Suchen', group: 'Aktion', run: () => this.dom.search.focus() },
      { label: 'Tastenkürzel anzeigen', group: 'Aktion', run: () => this.dom.shortcuts.showModal() },
      {
        label: 'Design umschalten',
        group: 'Aktion',
        run: () => el('theme-toggle').click(),
      },
      { label: 'Daten exportieren', group: 'Aktion', run: () => this.exportData() },
    );

    return [...list, ...(this.extraCommands() || [])];
  }

  openPalette() {
    this.paletteInput_commands = this.commands();
    this.dom.paletteInput.value = '';
    this.paletteIndex = 0;
    this.renderPalette();
    if (!this.dom.palette.open) this.dom.palette.showModal();
    this.dom.paletteInput.focus();
  }

  renderPalette() {
    const query = this.dom.paletteInput.value;
    const scored = (this.paletteInput_commands || [])
      .map((command, index) => ({ command, index, score: commandScore(query, command.label) }))
      .filter((hit) => hit.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    this.paletteHits = scored;
    if (this.paletteIndex >= scored.length) this.paletteIndex = 0;

    const list = this.dom.paletteList;
    list.textContent = '';

    if (!scored.length) {
      const empty = document.createElement('li');
      empty.className = 'palette-empty';
      empty.textContent = 'Kein Treffer.';
      list.appendChild(empty);
      return;
    }

    scored.forEach((hit, position) => {
      const li = document.createElement('li');
      li.className = `palette-item${position === this.paletteIndex ? ' is-active' : ''}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(position === this.paletteIndex));
      li.dataset.command = String(position);

      const label = document.createElement('span');
      label.textContent = hit.command.label;
      const group = document.createElement('span');
      group.className = 'palette-group';
      group.textContent = hit.command.group;

      li.append(label, group);
      list.appendChild(li);
    });
  }

  onPaletteKeydown(event) {
    const hits = this.paletteHits || [];
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.paletteIndex = (this.paletteIndex + 1) % Math.max(hits.length, 1);
      this.renderPalette();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.paletteIndex = (this.paletteIndex - 1 + hits.length) % Math.max(hits.length, 1);
      this.renderPalette();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.runCommand(this.paletteIndex);
    }
  }

  runCommand(position) {
    const hit = (this.paletteHits || [])[position];
    if (!hit) return;
    this.dom.palette.close();
    hit.command.run();
  }

  onViewClick(event) {
    const item = event.target.closest('[data-view]');
    if (item) {
      this.prefs.set('view', item.dataset.view);
      this.dom.sidebar.classList.remove('open');
      this.render();
      return;
    }

    const rename = event.target.closest('[data-rename]');
    if (rename) {
      const project = this.store.getProject(rename.dataset.rename);
      const name = prompt('Projekt umbenennen', project ? project.name : '');
      if (name) this.store.renameProject(rename.dataset.rename, name);
      return;
    }

    const remove = event.target.closest('[data-delete-project]');
    if (remove) {
      const id = remove.dataset.deleteProject;
      const project = this.store.getProject(id);
      if (project && confirm(`"${project.name}" löschen? Die Aufgaben wandern in den Eingang.`)) {
        this.store.deleteProject(id);
        if (this.prefs.get('view') === `project:${id}`) this.prefs.set('view', 'all');
        this.render();
      }
    }
  }

  onTaskClick(event) {
    // Timeline lines toggle their task directly.
    const timelineToggle = event.target.closest('[data-toggle]');
    if (timelineToggle) {
      this.toggleWithUndo(timelineToggle.dataset.toggle);
      return;
    }

    const taskEl = event.target.closest('.task');
    if (!taskEl) return;
    const id = taskEl.dataset.id;

    if (event.target.closest('[data-action="delete"]')) {
      const removed = this.store.deleteTask(id);
      if (removed) {
        this.showToast(`„${removed.task.title}" gelöscht`, () => {
          this.store.restoreTask(removed.task, removed.index);
          this.announce(`${removed.task.title} wiederhergestellt`);
        });
        this.announce(`${removed.task.title} gelöscht`);
      }
      return;
    }
    if (event.target.closest('[data-action="edit"]') || event.target.closest('.task-title')) {
      this.startEdit(id);
    }
  }

  onTaskChange(event) {
    const taskEl = event.target.closest('.task');
    if (!taskEl) return;
    const id = taskEl.dataset.id;

    if (event.target.matches('input[type="checkbox"]')) this.toggleWithUndo(id);
  }

  /** Tick a task off and offer to take it back — the most common misclick. */
  toggleWithUndo(id) {
    const task = this.store.toggleTask(id);
    if (!task) return;
    const state = task.done ? 'erledigt' : 'wieder offen';
    this.announce(`${task.title} ${state}`);
    this.showToast(`„${task.title}" ${state}`, () => {
      this.store.toggleTask(id);
      this.announce(`${task.title} zurückgesetzt`);
    });
  }

  startEdit(id) {
    this.editingId = id;
    this.render();
    const input = this.dom.container.querySelector('.edit-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  commitEdit(id, value) {
    this.editingId = null;
    this.store.updateTask(id, { title: value });
    this.render();
  }

  // -- toast -----------------------------------------------------------
  /**
   * @param {string} text
   * @param {(() => void)|null} undoAction reversal to offer, if there is one.
   *   Passing nothing shows a plain confirmation with no Undo button, rather
   *   than a button that would do nothing.
   */
  showToast(text, undoAction = null) {
    clearTimeout(this.undoTimer);
    this.undo = undoAction;
    this.dom.toastText.textContent = text;
    this.dom.toastAction.hidden = !undoAction;
    this.dom.toast.hidden = false;
    this.undoTimer = setTimeout(() => this.hideToast(), undoAction ? 8000 : 3000);
  }

  hideToast() {
    this.dom.toast.hidden = true;
    this.undo = null;
  }

  performUndo() {
    const action = this.undo;
    // Cleared before running, so an undo can safely queue its own toast.
    this.hideToast();
    if (action) action();
  }

  // -- import / export ---------------------------------------------------
  exportData() {
    const blob = new Blob([this.store.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `organizer-${toISODate(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this.announce('Daten exportiert');
  }

  async importData(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const merge = confirm(
        'OK: in die vorhandenen Daten einfügen.\nAbbrechen: alles durch die Datei ersetzen.'
      );
      const result = this.store.importJSON(text, merge ? 'merge' : 'replace');
      this.announce(`${result.tasks} Aufgaben und ${result.projects} Projekte importiert`);
      this.render();
    } catch {
      alert('Die Datei konnte nicht als Organizer-JSON gelesen werden.');
    }
  }

  // -- rendering ---------------------------------------------------------
  render() {
    const state = this.store.state;
    const today = this.today;
    const counts = countsFor(state.tasks, state.projects, today);
    const view = this.resolveView();

    this.renderSidebar(view, counts);
    this.renderProjectPicker();

    const query = this.dom.search.value;
    const visible = sortTasks(
      filterByView(state.tasks, view, today).filter((t) => matchesSearch(t, query)),
      this.dom.sort.value
    );

    this.dom.viewTitle.textContent = this.viewLabel(view);
    this.dom.viewSummary.textContent = this.summaryText(visible.length, query, counts, view);

    this.renderTasks(visible, view, today);
  }

  /** Fall back to 'all' if the stored view points at a deleted project. */
  resolveView() {
    const view = this.prefs.get('view') || 'today';
    if (view.startsWith('project:') && !this.store.getProject(view.slice(8))) return 'all';
    return view;
  }

  viewLabel(view) {
    if (view.startsWith('project:')) {
      const project = this.store.getProject(view.slice(8));
      return project ? project.name : 'Projekt';
    }
    const known = VIEWS.find((v) => v.id === view);
    return known ? known.label : 'Aufgaben';
  }

  summaryText(count, query, counts, view) {
    const noun = count === 1 ? 'Aufgabe' : 'Aufgaben';
    if (query.trim()) return `${count} ${noun} zu „${query.trim()}“`;

    // The dashboard leads with what is actually pressing today, not with
    // lifetime totals.
    if (view === 'today') {
      const plan = dayPlan(this.store.state.tasks, this.today);
      const parts = [`${plan.open} ${plan.open === 1 ? 'Aufgabe' : 'Aufgaben'} heute`];
      if (plan.overdue.length) parts.push(`${plan.overdue.length} überfällig`);
      if (plan.done) parts.push(`${plan.done} erledigt`);
      return parts.join(' · ');
    }
    return `${count} ${noun} · ${counts.all} offen gesamt · ${counts.completed} erledigt`;
  }

  renderSidebar(activeView, counts) {
    const list = this.dom.viewList;
    list.textContent = '';
    for (const view of VIEWS) {
      const li = document.createElement('li');
      const btn = this.button('side-item', '', { view: view.id });
      btn.setAttribute('aria-current', String(view.id === activeView));
      btn.title = view.label;

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = view.icon;
      icon.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = view.label;

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = counts[view.id];

      btn.append(icon, label, count);
      li.appendChild(btn);
      list.appendChild(li);
    }

    const projects = this.dom.projectList;
    projects.textContent = '';
    if (!this.store.getProjects().length) {
      const li = document.createElement('li');
      li.className = 'count';
      li.style.padding = '4px 8px';
      li.textContent = 'Noch keine Projekte';
      projects.appendChild(li);
    }
    for (const project of this.store.getProjects()) {
      const li = document.createElement('li');
      li.className = 'project-row';

      const btn = this.button('side-item', '', { view: `project:${project.id}` });
      btn.setAttribute('aria-current', String(`project:${project.id}` === activeView));
      btn.title = project.name;

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = project.color;

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = project.name;

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = counts.projects[project.id] || 0;

      btn.append(dot, label, count);

      const actions = document.createElement('span');
      actions.className = 'row-actions';
      const rename = this.button('icon-btn', '✎', { rename: project.id });
      rename.setAttribute('aria-label', `${project.name} umbenennen`);
      const del = this.button('icon-btn', '✕', { deleteProject: project.id });
      del.setAttribute('aria-label', `${project.name} löschen`);
      actions.append(rename, del);

      li.append(btn, actions);
      projects.appendChild(li);
    }
  }

  /** Keeps the new-task project dropdown in sync without losing the selection. */
  renderProjectPicker() {
    const select = this.dom.project;
    const previous = select.value;
    select.textContent = '';

    const inbox = document.createElement('option');
    inbox.value = '';
    inbox.textContent = 'Eingang';
    select.appendChild(inbox);

    for (const project of this.store.getProjects()) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      select.appendChild(option);
    }

    const view = this.resolveView();
    if (previous && this.store.getProject(previous)) select.value = previous;
    else if (view.startsWith('project:')) select.value = view.slice(8);
  }

  renderTasks(tasks, view, today) {
    const container = this.dom.container;
    container.textContent = '';

    // "Heute" is the dashboard: the day itself as a timeline first, then a
    // look ahead. Searching falls back to the plain list — a timeline of
    // search hits would be nonsense.
    if (view === 'today' && !this.dom.search.value.trim()) {
      this.renderDayPlan(container, today);
      this.renderLookahead(container, today);
      return;
    }

    if (!tasks.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = this.dom.search.value.trim()
        ? 'Keine Aufgabe passt zur Suche.'
        : 'Nichts da. Lege oben eine Aufgabe an.';
      container.appendChild(empty);
      return;
    }

    // Only the date-oriented views earn date groupings.
    const grouped = ['today', 'upcoming', 'all'].includes(view) && this.dom.sort.value === 'due';
    const groups = grouped
      ? groupByDue(tasks, today)
      : [{ key: 'flat', label: '', tasks }];

    for (const group of groups) {
      if (group.label) {
        const heading = document.createElement('h3');
        heading.className = 'group-heading';
        heading.textContent = `${group.label} · ${group.tasks.length}`;
        container.appendChild(heading);
      }
      const ul = document.createElement('ul');
      ul.className = 'task-list';
      for (const task of group.tasks) ul.appendChild(this.taskElement(task, today));
      container.appendChild(ul);
    }
  }

  /**
   * The day as a timeline: what happens when, in the order it happens.
   * Lessons and tasks share one line of time — the point of a day plan is that
   * you look in exactly one place.
   */
  renderDayPlan(container, today) {
    const plan = dayPlan(this.store.state.tasks, today);
    const lessons = this.lessonsForDay(toISODate(today)) || [];

    const section = document.createElement('section');
    section.className = 'day-plan';

    const head = document.createElement('h3');
    head.className = 'day-plan-head';
    head.textContent = `Heute · ${formatDayHeading(today)}`;
    section.appendChild(head);

    // Timed tasks and lessons interleave strictly by clock time.
    const timed = [
      ...plan.timed.map((task) => ({ time: task.dueTime, task })),
      ...lessons.map((lesson) => ({ time: lesson.start_time, lesson })),
    ].sort((a, b) => String(a.time).localeCompare(String(b.time)));

    if (!timed.length && !plan.untimed.length) {
      const empty = document.createElement('p');
      empty.className = 'day-plan-empty';
      empty.textContent = 'Heute ist nichts geplant.';
      section.appendChild(empty);
    }

    if (timed.length) {
      const list = document.createElement('ol');
      list.className = 'timeline';
      for (const entry of timed) list.appendChild(this.timelineEntry(entry));
      section.appendChild(list);
    }

    if (plan.untimed.length) {
      const heading = document.createElement('p');
      heading.className = 'timeline-subhead';
      heading.textContent = 'Ohne feste Uhrzeit';
      section.appendChild(heading);

      const list = document.createElement('ol');
      list.className = 'timeline';
      for (const task of plan.untimed) list.appendChild(this.timelineEntry({ task }));
      section.appendChild(list);
    }

    const foot = document.createElement('p');
    foot.className = 'day-plan-foot';
    foot.textContent = plan.open
      ? `Noch offen: ${plan.open} ${plan.open === 1 ? 'Aufgabe' : 'Aufgaben'}`
      : 'Alles erledigt für heute.';
    section.appendChild(foot);

    container.appendChild(section);

    if (plan.overdue.length) {
      const heading = document.createElement('h3');
      heading.className = 'group-heading is-overdue';
      heading.textContent = `Überfällig · ${plan.overdue.length}`;
      container.appendChild(heading);

      const ul = document.createElement('ul');
      ul.className = 'task-list';
      for (const task of plan.overdue) ul.appendChild(this.taskElement(task, today));
      container.appendChild(ul);
    }
  }

  /** One line of the day: priority dot, clock time, what it is. */
  timelineEntry({ time, task, lesson }) {
    const li = document.createElement('li');

    if (lesson) {
      li.className = `timeline-entry is-lesson ${lesson.status || ''}`.trim();
      if (lesson.subject_color) li.style.setProperty('--entry-accent', lesson.subject_color);

      const dot = document.createElement('span');
      dot.className = 'timeline-dot';
      li.appendChild(dot);

      const clock = document.createElement('span');
      clock.className = 'timeline-time';
      clock.textContent = time || '';
      li.appendChild(clock);

      const label = document.createElement('span');
      label.className = 'timeline-title';
      label.textContent = lesson.subject_name || 'Unterricht';
      li.appendChild(label);

      const tag = document.createElement('span');
      tag.className = 'timeline-kind';
      tag.textContent = lesson.status === 'cancelled' ? 'Entfall' : 'Unterricht';
      li.appendChild(tag);
      return li;
    }

    li.className = `timeline-entry prio-${task.priority}${task.done ? ' is-done' : ''}`;

    // The whole line toggles the task: in a day plan, ticking something off is
    // the action you take, so it should not require aiming at a small box.
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'timeline-button';
    button.dataset.toggle = task.id;
    button.setAttribute('aria-pressed', String(task.done));
    button.title = task.done ? 'Als offen markieren' : 'Als erledigt markieren';

    const dot = document.createElement('span');
    dot.className = 'timeline-dot';
    button.appendChild(dot);

    const clock = document.createElement('span');
    clock.className = 'timeline-time';
    clock.textContent = task.dueTime || '—';
    button.appendChild(clock);

    const label = document.createElement('span');
    label.className = 'timeline-title';
    label.textContent = task.title;
    button.appendChild(label);

    li.appendChild(button);
    return li;
  }

  /** What is coming after today, so the dashboard is not blind past midnight. */
  renderLookahead(container, today) {
    const iso = toISODate(today);
    const ahead = this.store.state.tasks
      .filter((t) => !t.done && t.dueDate && t.dueDate > iso);
    if (!ahead.length) return;

    for (const group of groupByDue(ahead, today)) {
      const heading = document.createElement('h3');
      heading.className = 'group-heading';
      heading.textContent = `${group.label} · ${group.tasks.length}`;
      container.appendChild(heading);

      const ul = document.createElement('ul');
      ul.className = 'task-list';
      for (const task of sortTasks(group.tasks, 'due')) {
        ul.appendChild(this.taskElement(task, today));
      }
      container.appendChild(ul);
    }
  }

  taskElement(task, today) {
    const li = document.createElement('li');
    li.className = `task prio-${task.priority}${task.done ? ' is-done' : ''}`;
    li.dataset.id = task.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.setAttribute('aria-label', `"${task.title}" als ${task.done ? 'offen' : 'erledigt'} markieren`);

    const body = document.createElement('div');
    body.className = 'task-body';

    if (this.editingId === task.id) {
      const input = document.createElement('input');
      input.className = 'edit-input';
      input.type = 'text';
      input.value = task.title;
      input.setAttribute('aria-label', 'Aufgabentitel bearbeiten');
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.commitEdit(task.id, input.value);
        }
      });
      input.addEventListener('blur', () => {
        if (this.editingId === task.id) this.commitEdit(task.id, input.value);
      });
      body.appendChild(input);
    } else {
      const title = document.createElement('span');
      title.className = 'task-title';
      title.textContent = task.title;
      title.title = 'Zum Bearbeiten klicken';
      body.appendChild(title);
    }

    const meta = document.createElement('div');
    meta.className = 'task-meta';

    const project = task.projectId ? this.store.getProject(task.projectId) : null;
    if (project) {
      const ref = document.createElement('span');
      ref.className = 'project-ref';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = project.color;
      const name = document.createElement('span');
      name.textContent = project.name;
      ref.append(dot, name);
      meta.appendChild(ref);
    }

    for (const tag of task.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = `#${tag}`;
      meta.appendChild(chip);
    }

    if (meta.childNodes.length) body.appendChild(meta);

    // Priority and deadline sit on the right, where the eye can scan a column
    // of them instead of hunting through each line's metadata.
    const side = document.createElement('div');
    side.className = 'task-side';

    if (task.priority !== 'normal') {
      const prio = document.createElement('span');
      prio.className = `prio-badge prio-${task.priority}`;
      prio.textContent = task.priority === 'high' ? 'Hoch' : 'Niedrig';
      prio.title = task.priority === 'high' ? 'Hohe Priorität' : 'Niedrige Priorität';
      side.appendChild(prio);
    }

    if (task.dueDate) {
      const due = document.createElement('span');
      const overdue = !task.done && task.dueDate < toISODate(today);
      due.className = `task-due${overdue ? ' overdue' : ''}`;
      due.textContent = task.dueTime
        ? `${formatDue(task.dueDate, today)}, ${task.dueTime}`
        : formatDue(task.dueDate, today);
      side.appendChild(due);
    }

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const edit = this.button('icon-btn', '✏️', { action: 'edit' });
    edit.setAttribute('aria-label', `"${task.title}" bearbeiten`);
    edit.title = 'Bearbeiten';
    const del = this.button('icon-btn', '🗑️', { action: 'delete' });
    del.setAttribute('aria-label', `"${task.title}" löschen`);
    del.title = 'Löschen';
    actions.append(edit, del);

    // Dragging is only meaningful once the list is not being reordered by a
    // sort rule; dropping switches the app to manual sorting so the new
    // position actually survives the next render.
    li.draggable = this.editingId !== task.id;

    li.append(checkbox, body, side, actions);
    return li;
  }
}

export { VIEWS, PRIORITIES };
