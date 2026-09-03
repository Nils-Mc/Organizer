# Organizer

A small, offline-first task and project organizer. No build step, no
dependencies, no server, no account — open `index.html` in a browser and it
works. Your data stays in that browser's `localStorage`, and you can export it
to JSON at any time.

## Running it

Open `index.html` directly, or serve the folder if you prefer a real origin:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

A static host works too — the whole app is just HTML, CSS and ES modules.

## Features

- **Tasks** with a due date, a low/normal/high priority, and `#tags` typed
  straight into the title (`Send the report #finance`).
- **Projects** with colour coding; anything unassigned lives in the Inbox.
  Deleting a project returns its tasks to the Inbox rather than destroying them.
- **Views**: Today (due today *and* overdue), Upcoming, All open, Inbox,
  Completed, plus one view per project.
- **Grouping** by Overdue / Today / Tomorrow / This week / Later / No due date.
- **Search** across titles, notes and tags; sort by due date, priority, newest
  or title.
- **Undo** after deleting a task (8-second window).
- **Import / export** JSON, either replacing your data or merging into it.
- **Light and dark** themes, following the system setting with a manual override.

### Keyboard

| Key | Action |
|---|---|
| `n` | Focus the new-task field |
| `/` | Focus search |
| `Enter` | Submit the new task, or save an inline edit |
| `Esc` | Cancel an edit, or clear the search box |

Click a task's title to edit it in place.

## Data format

Everything is one versioned object under the `organizer.v1` key — the same
shape the export produces, so an exported file can be edited by hand and
imported back:

```json
{
  "version": 1,
  "projects": [
    { "id": "…", "name": "Work", "color": "#3b6ef5", "createdAt": "…" }
  ],
  "tasks": [
    {
      "id": "…",
      "title": "Send the quarterly report",
      "notes": "",
      "projectId": "…",
      "done": false,
      "dueDate": "2026-09-10",
      "priority": "high",
      "tags": ["finance"],
      "createdAt": "…", "updatedAt": "…", "completedAt": null
    }
  ]
}
```

`projectId` is `null` for Inbox tasks, and `dueDate` is a local `YYYY-MM-DD`
calendar day (not a timestamp — "due today" should not depend on your time
zone). Imported data is validated field by field: malformed records are
dropped rather than trusted, so a corrupt file can't break the app.

## Layout

```
index.html      markup shell
css/styles.css  design tokens, light/dark, responsive layout
js/store.js     persistence, CRUD, import/export      (no DOM)
js/filters.js   filtering, sorting, date bucketing    (no DOM, pure)
js/ui.js        rendering and event wiring
js/app.js       entry point
tests/          unit tests for store.js and filters.js
```

`store.js` and `filters.js` avoid the DOM deliberately, which is what lets the
test suite run headlessly.

## Tests

```sh
node tests/run.js     # headless
```

Or open `tests/test.html` in a browser for the same suite with a visual report.
