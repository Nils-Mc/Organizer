/**
 * The school half of the app: timetable, subjects, notes, materials, search.
 *
 * Renders into #school-panel. The task half is untouched and keeps working
 * offline; this panel simply stays hidden when no backend answers.
 */

import { api, probe, ApiError } from './api.js';
import {
  startOfWeek, shiftWeeks, weekRange, groupByDay, weekHighlights, weekLabel,
  upcomingToday, asDueItems, toISODate,
} from './schedule.js';
import { formatDue } from './filters.js';

const el = (id) => document.getElementById(id);

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const STATUS_LABEL = {
  cancelled: 'Entfall',
  substitution: 'Vertretung',
};

export class School {
  constructor(root, announce) {
    this.root = root;
    this.announce = announce || (() => {});
    this.state = null;
    this.mode = 'offline';
    this.view = 'timetable';
    this.weekStart = startOfWeek(new Date());
    this.activeSubject = null;
    this.busy = false;
    // Generated content is keyed by note id and rendered from here. Appending it
    // straight to the DOM would be wiped by the next render, which run() always
    // triggers.
    this.noteExtras = new Map();
  }

  get today() { return new Date(); }

  async init() {
    this.mode = await probe();
    if (this.mode === 'ready') await this.load();
    this.render();
    return this.mode;
  }

  async load() {
    try {
      this.state = await api.state();
      this.mode = 'ready';
    } catch (error) {
      this.mode = error.unauthorized ? 'login' : 'offline';
    }
  }

  /** Run an async action, showing progress and surfacing failure as text. */
  async run(label, fn) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.busyLabel = label;
    this.render();
    try {
      await fn();
    } catch (error) {
      this.error = error instanceof ApiError ? error.message : String(error);
      if (error instanceof ApiError && error.unauthorized) this.mode = 'login';
    } finally {
      this.busy = false;
      this.busyLabel = null;
      this.render();
    }
  }

  // ---- rendering -------------------------------------------------------
  render() {
    this.root.textContent = '';
    this.root.hidden = false;

    if (this.mode === 'offline') { this.root.hidden = true; return; }
    if (this.mode === 'login') { this.root.appendChild(this.loginForm()); return; }

    this.root.appendChild(this.header());
    if (this.error) {
      const box = node('p', 'school-error', this.error);
      box.setAttribute('role', 'alert');
      this.root.appendChild(box);
    }
    if (this.busy) this.root.appendChild(node('p', 'school-busy', `${this.busyLabel}…`));

    if (this.view === 'timetable') this.root.appendChild(this.timetable());
    else if (this.view === 'subjects') this.root.appendChild(this.subjects());
    else if (this.view === 'search') this.root.appendChild(this.search());
  }

  loginForm() {
    const wrap = node('form', 'school-login');
    wrap.appendChild(node('h2', null, 'Schul-Bereich'));
    wrap.appendChild(node('p', 'muted', 'Passwort eingeben, um Stundenplan und Fächer zu laden.'));

    const input = document.createElement('input');
    input.type = 'password';
    input.required = true;
    input.autocomplete = 'current-password';
    input.setAttribute('aria-label', 'Passwort');
    input.placeholder = 'Passwort';

    const button = node('button', 'primary-btn', 'Anmelden');
    button.type = 'submit';

    const error = node('p', 'school-error');
    error.setAttribute('role', 'alert');

    wrap.append(input, button, error);
    wrap.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      try {
        await api.login(input.value);
        await this.load();
        this.render();
        this.announce('Angemeldet');
      } catch (e) {
        error.textContent = e.message;
      }
    });
    return wrap;
  }

  header() {
    const bar = node('div', 'school-bar');

    for (const [id, label] of [
      ['timetable', 'Stundenplan'], ['subjects', 'Fächer'], ['search', 'Suche'],
    ]) {
      const button = node('button', 'chip', label);
      button.type = 'button';
      button.setAttribute('aria-current', String(this.view === id));
      button.addEventListener('click', () => {
        this.view = id;
        this.activeSubject = null;
        this.render();
      });
      bar.appendChild(button);
    }

    const spacer = node('span', 'spacer');
    bar.appendChild(spacer);

    const last = this.state && this.state.lastSync;
    bar.appendChild(node('span', 'muted small',
      last ? `Sync: ${new Date(last).toLocaleString('de-DE')}` : 'Noch kein Sync'));

    const sync = node('button', 'link-btn', 'Jetzt synchronisieren');
    sync.type = 'button';
    sync.addEventListener('click', () => this.run('Synchronisiere', async () => {
      const result = await api.sync();
      await this.load();
      this.announce(`Sync fertig: ${result.lessons.inserted + result.lessons.updated} Stunden aktualisiert`);
    }));
    bar.appendChild(sync);

    return bar;
  }

  // ---- timetable --------------------------------------------------------
  timetable() {
    const wrap = node('section', 'school-section');
    const lessons = (this.state && this.state.lessons) || [];
    const { from, to } = weekRange(this.weekStart);
    const inWeek = lessons.filter((l) => l.date >= from && l.date <= to);

    // Week navigation
    const nav = node('div', 'week-nav');
    const prev = node('button', 'icon-btn', '‹');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Vorige Woche');
    prev.addEventListener('click', () => { this.weekStart = shiftWeeks(this.weekStart, -1); this.render(); });

    const next = node('button', 'icon-btn', '›');
    next.type = 'button';
    next.setAttribute('aria-label', 'Nächste Woche');
    next.addEventListener('click', () => { this.weekStart = shiftWeeks(this.weekStart, 1); this.render(); });

    const heute = node('button', 'link-btn', 'Heute');
    heute.type = 'button';
    heute.addEventListener('click', () => { this.weekStart = startOfWeek(new Date()); this.render(); });

    nav.append(prev, node('h2', null, weekLabel(this.weekStart)), next, heute);
    wrap.appendChild(nav);

    // What changed this week
    const h = weekHighlights(inWeek);
    if (h.cancelled.length || h.substituted.length) {
      const summary = node('p', 'week-highlights');
      if (h.cancelled.length) summary.appendChild(node('span', 'pill cancelled', `${h.cancelled.length}× Entfall`));
      if (h.substituted.length) summary.appendChild(node('span', 'pill substitution', `${h.substituted.length}× Vertretung`));
      wrap.appendChild(summary);
    }

    // Next lessons today
    const ahead = upcomingToday(lessons, this.today);
    if (ahead.length) {
      const nextUp = node('p', 'muted small',
        `Als Nächstes: ${ahead[0].subject_name || '—'} um ${ahead[0].start_time}`);
      wrap.appendChild(nextUp);
    }

    if (!inWeek.length) {
      wrap.appendChild(node('p', 'empty', 'Keine Stunden in dieser Woche. Schon synchronisiert?'));
      return wrap;
    }

    const grid = node('div', 'week-grid');
    for (const day of groupByDay(inWeek, this.weekStart)) {
      const column = node('div', 'day-column');
      const head = node('h3', 'day-head');
      head.append(node('span', null, day.label));
      head.append(node('span', 'muted small', day.date.slice(8) + '.' + day.date.slice(5, 7) + '.'));
      if (day.date === toISODate(this.today)) column.classList.add('is-today');
      column.appendChild(head);

      if (!day.lessons.length) column.appendChild(node('p', 'muted small', 'frei'));

      for (const lesson of day.lessons) {
        const card = node('div', `lesson ${lesson.status}`);
        if (lesson.subject_color) card.style.borderLeftColor = lesson.subject_color;

        card.appendChild(node('strong', null, lesson.subject_name || '—'));
        card.appendChild(node('span', 'muted small', `${lesson.start_time}–${lesson.end_time}`));

        const meta = [];
        const rooms = safeList(lesson.rooms);
        const teachers = safeList(lesson.teachers);
        if (rooms.length) meta.push(rooms.join(', '));
        if (teachers.length) meta.push(teachers.join(', '));
        if (meta.length) card.appendChild(node('span', 'muted small', meta.join(' · ')));

        if (STATUS_LABEL[lesson.status]) {
          card.appendChild(node('span', `pill ${lesson.status}`, STATUS_LABEL[lesson.status]));
        }
        if (lesson.note) card.appendChild(node('span', 'muted small', lesson.note));

        column.appendChild(card);
      }
      grid.appendChild(column);
    }
    wrap.appendChild(grid);

    // Homework and exams, reusing the same due-date vocabulary as the task half
    const due = asDueItems(this.state || {}).filter((d) => !d.done && d.dueDate);
    if (due.length) {
      wrap.appendChild(node('h3', 'group-heading', 'Fällig'));
      const list = node('ul', 'task-list');
      for (const item of due.sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
        list.appendChild(this.dueRow(item));
      }
      wrap.appendChild(list);
    }
    return wrap;
  }

  dueRow(item) {
    const li = node('li', `task ${item.kind === 'exam' ? 'prio-high' : 'prio-normal'}`);
    if (item.color) li.style.borderLeftColor = item.color;

    if (item.kind === 'homework') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.done;
      box.setAttribute('aria-label', `"${item.title}" abhaken`);
      box.addEventListener('change', () => this.run('Speichere', async () => {
        await api.setHomeworkCompleted(item.id, box.checked);
        await this.load();
      }));
      li.appendChild(box);
    } else {
      li.appendChild(node('span', 'exam-marker', '★'));
    }

    const body = node('div', 'task-body');
    body.appendChild(node('span', 'task-title', item.title));
    const meta = node('div', 'task-meta');
    if (item.dueDate) {
      const due = node('span', null, formatDue(item.dueDate, this.today));
      if (item.dueDate < toISODate(this.today)) due.className = 'overdue';
      meta.appendChild(due);
    }
    if (item.subject) meta.appendChild(node('span', null, item.subject));
    meta.appendChild(node('span', 'tag', item.kind === 'exam' ? 'Klausur' : 'Hausaufgabe'));
    body.appendChild(meta);
    li.appendChild(body);
    return li;
  }

  // ---- subjects ----------------------------------------------------------
  subjects() {
    const wrap = node('section', 'school-section');
    const subjects = (this.state && this.state.subjects) || [];

    if (this.activeSubject) return this.subjectDetail(wrap);

    wrap.appendChild(node('h2', null, 'Fächer'));
    if (!subjects.length) {
      wrap.appendChild(node('p', 'empty', 'Noch keine Fächer. Synchronisiere zuerst mit WebUntis.'));
      return wrap;
    }

    const grid = node('div', 'subject-grid');
    for (const subject of subjects) {
      const card = node('button', 'subject-card');
      card.type = 'button';
      if (subject.color) card.style.borderLeftColor = subject.color;
      card.appendChild(node('strong', null, subject.long_name || subject.name));
      card.appendChild(node('span', 'muted small',
        `${subject.note_count || 0} Notizen · ${subject.material_count || 0} Dateien` +
        (subject.open_homework ? ` · ${subject.open_homework} offen` : '')));
      card.addEventListener('click', () => {
        this.activeSubject = subject;
        this.subjectData = null;
        this.render();
        this.loadSubject(subject.id);
      });
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  async loadSubject(id) {
    await this.run('Lade Fach', async () => {
      const [notes, materials] = await Promise.all([api.notes(id), api.materials(id)]);
      this.subjectData = { notes: notes.notes || [], materials: materials.materials || [] };
    });
  }

  subjectDetail(wrap) {
    const subject = this.activeSubject;

    const back = node('button', 'link-btn', '‹ Alle Fächer');
    back.type = 'button';
    back.addEventListener('click', () => { this.activeSubject = null; this.render(); });
    wrap.appendChild(back);
    wrap.appendChild(node('h2', null, subject.long_name || subject.name));

    // --- new note
    const form = node('form', 'note-form');
    const title = document.createElement('input');
    title.placeholder = 'Titel der Notiz';
    title.required = true;
    title.setAttribute('aria-label', 'Titel der Notiz');

    const body = document.createElement('textarea');
    body.placeholder = 'Text (Markdown)';
    body.rows = 3;
    body.setAttribute('aria-label', 'Text der Notiz');

    const save = node('button', 'primary-btn', 'Notiz speichern');
    save.type = 'submit';
    form.append(title, body, save);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.run('Speichere Notiz', async () => {
        await api.createNote(subject.id, { title: title.value, body: body.value });
        title.value = ''; body.value = '';
        await this.loadSubjectQuiet(subject.id);
        this.announce('Notiz gespeichert');
      });
    });
    wrap.appendChild(form);

    // --- upload
    const upload = node('form', 'upload-form');
    const file = document.createElement('input');
    file.type = 'file';
    file.setAttribute('aria-label', 'Datei hochladen');
    const up = node('button', 'primary-btn', 'Hochladen');
    up.type = 'submit';
    upload.append(file, up);
    upload.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!file.files || !file.files[0]) return;
      const data = new FormData();
      data.append('file', file.files[0]);
      this.run('Lade hoch', async () => {
        await api.upload(subject.id, data);
        file.value = '';
        await this.loadSubjectQuiet(subject.id);
        this.announce('Datei hochgeladen');
      });
    });
    wrap.appendChild(upload);

    const data = this.subjectData;
    if (!data) {
      wrap.appendChild(node('p', 'muted', 'Lade…'));
      return wrap;
    }

    // --- notes
    wrap.appendChild(node('h3', 'group-heading', `Notizen · ${data.notes.length}`));
    if (!data.notes.length) wrap.appendChild(node('p', 'empty', 'Noch keine Notizen.'));
    for (const note of data.notes) {
      const card = node('article', 'note-card');
      card.appendChild(node('h4', null, note.title));
      if (note.body) card.appendChild(node('p', null, note.body));
      card.appendChild(node('span', 'muted small',
        new Date(note.updated_at).toLocaleString('de-DE')));

      // Anything generated earlier for this note, restored from state.
      const extras = this.noteExtras.get(note.id) || {};
      if (extras.summary) card.appendChild(node('div', 'summary', extras.summary));
      if (extras.cards) {
        const list = node('ul', 'flashcards');
        for (const c of extras.cards) {
          const li = node('li');
          li.appendChild(node('strong', null, c.front));
          li.appendChild(node('span', null, c.back));
          list.appendChild(li);
        }
        if (!extras.cards.length) list.appendChild(node('li', 'muted', 'Keine Karten erzeugt.'));
        card.appendChild(list);
      }

      const actions = node('div', 'note-actions');
      const summarize = node('button', 'link-btn', 'Zusammenfassen');
      summarize.type = 'button';
      summarize.addEventListener('click', () => this.run('Fasse zusammen', async () => {
        const { summary } = await api.summarize({
          text: `${note.title}\n\n${note.body}`, subject: subject.name, noteId: note.id,
        });
        this.noteExtras.set(note.id, { ...this.noteExtras.get(note.id), summary: summary.body });
      }));

      const cards = node('button', 'link-btn', 'Lernkarten');
      cards.type = 'button';
      cards.addEventListener('click', () => this.run('Erzeuge Lernkarten', async () => {
        const { cards: generated } = await api.generateFlashcards({
          text: `${note.title}\n\n${note.body}`, subject: subject.name,
        });
        this.noteExtras.set(note.id, { ...this.noteExtras.get(note.id), cards: generated });
      }));

      const remove = node('button', 'link-btn', 'Löschen');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        if (!confirm(`Notiz "${note.title}" löschen?`)) return;
        this.run('Lösche', async () => {
          await api.deleteNote(note.id);
          await this.loadSubjectQuiet(subject.id);
        });
      });

      actions.append(summarize, cards, remove);
      card.appendChild(actions);
      wrap.appendChild(card);
    }

    // --- materials
    wrap.appendChild(node('h3', 'group-heading', `Dateien · ${data.materials.length}`));
    if (!data.materials.length) wrap.appendChild(node('p', 'empty', 'Noch keine Dateien.'));
    for (const material of data.materials) {
      const row = node('div', 'material-row');
      row.appendChild(node('span', null, material.filename));
      row.appendChild(node('span', 'tag', material.kind === 'audio' ? 'Audio' : 'Dokument'));
      row.appendChild(node('span', 'muted small', material.status));
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** Reload subject content without the spinner stealing focus mid-edit. */
  async loadSubjectQuiet(id) {
    const [notes, materials] = await Promise.all([api.notes(id), api.materials(id)]);
    this.subjectData = { notes: notes.notes || [], materials: materials.materials || [] };
    await this.load();
  }

  // ---- search ------------------------------------------------------------
  search() {
    const wrap = node('section', 'school-section');
    wrap.appendChild(node('h2', null, 'Suche'));

    const form = node('form', 'search-form');
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Notizen, Transkripte, Zusammenfassungen…';
    input.setAttribute('aria-label', 'Suchbegriff');
    input.value = this.searchQuery || '';
    const go = node('button', 'primary-btn', 'Suchen');
    go.type = 'submit';
    form.append(input, go);

    const results = node('div', 'search-results');

    // Rendered from state, not appended in the handler: run() re-renders when it
    // finishes and would throw away anything written directly into the DOM.
    if (this.searchResults) {
      if (!this.searchResults.length) {
        results.appendChild(node('p', 'empty', 'Nichts gefunden.'));
      }
      for (const hit of this.searchResults) {
        const card = node('article', 'search-hit');
        card.appendChild(node('h4', null, hit.title || '(ohne Titel)'));
        card.appendChild(node('span', 'tag', hit.kind));
        if (hit.snippet) card.appendChild(node('p', null, hit.snippet));
        results.appendChild(card);
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.searchQuery = input.value;
      this.run('Suche', async () => {
        const { results: found } = await api.search(input.value);
        this.searchResults = found;
      });
    });

    wrap.append(form, results);
    return wrap;
  }
}

/** Teachers and rooms are stored as JSON strings; never let a bad row break a render. */
function safeList(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export { safeList };
