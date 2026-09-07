/**
 * Rendering and DOM event wiring. The only module that touches the document.
 */
import { PRIORITIES } from './store.js';
import {
  filterByView, sortTasks, groupByDue, matchesSearch,
  countsFor, formatDue, toISODate,
} from './filters.js';

const VIEWS = [
  { id: 'today', label: 'Heute', icon: '☀' },
  { id: 'upcoming', label: 'Demnächst', icon: '▸' },
  { id: 'all', label: 'Alle offenen', icon: '≡' },
  { id: 'inbox', label: 'Eingang', icon: '✉' },
  { id: 'completed', label: 'Erledigt', icon: '✓' },
];

const el = (id) => document.getElementById(id);

export class UI {
  constructor(store, prefs) {
    this.store = store;
    this.prefs = prefs;
    this.editingId = null;
    this.undo = null;
    this.undoTimer = null;

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
      priority: el('new-task-priority'),
      project: el('new-task-project'),
      sidebar: el('sidebar'),
      toast: el('toast'),
      toastText: el('toast-text'),
      toastAction: el('toast-action'),
      live: el('live-region'),
    };

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
      const task = this.store.addTask({
        title: d.title.value,
        dueDate: d.due.value || null,
        priority: d.priority.value,
        projectId: d.project.value || null,
      });
      if (!task) return;
      d.title.value = '';
      d.due.value = '';
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

    el('theme-toggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      this.prefs.set('theme', next);
    });

    el('export-btn').addEventListener('click', () => this.exportData());
    el('import-btn').addEventListener('click', () => el('import-file').click());
    el('import-file').addEventListener('change', (e) => this.importData(e));

    d.toastAction.addEventListener('click', () => this.performUndo());

    document.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  onKeydown(event) {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);

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
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'n') {
      event.preventDefault();
      this.dom.title.focus();
    } else if (event.key === '/') {
      event.preventDefault();
      this.dom.search.focus();
    }
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
    const taskEl = event.target.closest('.task');
    if (!taskEl) return;
    const id = taskEl.dataset.id;

    if (event.target.closest('[data-action="delete"]')) {
      const removed = this.store.deleteTask(id);
      if (removed) {
        this.undo = removed;
        this.showToast(`"${removed.task.title}" gelöscht`);
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

    if (event.target.matches('input[type="checkbox"]')) {
      const task = this.store.toggleTask(id);
      if (task) this.announce(`${task.title} ${task.done ? 'erledigt' : 'wieder offen'}`);
    }
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
  showToast(text) {
    clearTimeout(this.undoTimer);
    this.dom.toastText.textContent = text;
    this.dom.toast.hidden = false;
    this.undoTimer = setTimeout(() => this.hideToast(), 8000);
  }

  hideToast() {
    this.dom.toast.hidden = true;
    this.undo = null;
  }

  performUndo() {
    if (this.undo) {
      this.store.restoreTask(this.undo.task, this.undo.index);
      this.announce(`${this.undo.task.title} wiederhergestellt`);
    }
    this.hideToast();
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
    this.dom.viewSummary.textContent = this.summaryText(visible.length, query, counts);

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

  summaryText(count, query, counts) {
    const noun = count === 1 ? 'Aufgabe' : 'Aufgaben';
    if (query.trim()) return `${count} ${noun} zu „${query.trim()}“`;
    return `${count} ${noun} · ${counts.all} offen gesamt · ${counts.completed} erledigt`;
  }

  renderSidebar(activeView, counts) {
    const list = this.dom.viewList;
    list.textContent = '';
    for (const view of VIEWS) {
      const li = document.createElement('li');
      const btn = this.button('side-item', '', { view: view.id });
      btn.setAttribute('aria-current', String(view.id === activeView));

      const icon = document.createElement('span');
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

    if (task.dueDate) {
      const due = document.createElement('span');
      const overdue = !task.done && new Date(task.dueDate) < new Date(toISODate(today));
      due.className = overdue ? 'overdue' : '';
      due.textContent = formatDue(task.dueDate, today);
      meta.appendChild(due);
    }

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

    if (task.priority !== 'normal') {
      const prio = document.createElement('span');
      prio.textContent = { high: 'hohe Priorität', low: 'niedrige Priorität' }[task.priority] || '';
      meta.appendChild(prio);
    }

    for (const tag of task.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = `#${tag}`;
      meta.appendChild(chip);
    }

    if (meta.childNodes.length) body.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const edit = this.button('icon-btn', '✎', { action: 'edit' });
    edit.setAttribute('aria-label', `"${task.title}" bearbeiten`);
    const del = this.button('icon-btn', '✕', { action: 'delete' });
    del.setAttribute('aria-label', `"${task.title}" löschen`);
    actions.append(edit, del);

    li.append(checkbox, body, actions);
    return li;
  }
}

export { VIEWS, PRIORITIES };
