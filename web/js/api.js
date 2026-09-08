/**
 * Thin client for the Worker API.
 *
 * The app must stay usable when the backend is absent — it started life as a
 * purely local task app and that half still works offline. So every call here
 * reports failure as a value the UI can render, and never throws into a render
 * path.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.unauthorized = status === 401;
    this.unavailable = status === 503;
  }
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options });
  } catch {
    // Offline, or the app is being served without the Worker behind it.
    throw new ApiError('Keine Verbindung zum Server.', 0);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(
      (payload && payload.error) || `Serverfehler (${response.status}).`,
      response.status
    );
  }
  return payload;
}

export const api = {
  login: (password) =>
    request('/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password }) }),

  logout: () => request('/logout', { method: 'POST' }),

  state: () => request('/state'),

  sync: () => request('/sync', { method: 'POST' }),

  setHomeworkCompleted: (id, completed) =>
    request(`/homework/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ completed }),
    }),

  notes: (subjectId) => request(`/subjects/${encodeURIComponent(subjectId)}/notes`),

  createNote: (subjectId, note) =>
    request(`/subjects/${encodeURIComponent(subjectId)}/notes`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(note),
    }),

  updateNote: (id, note) =>
    request(`/notes/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(note),
    }),

  deleteNote: (id) => request(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  materials: (subjectId) => request(`/subjects/${encodeURIComponent(subjectId)}/materials`),

  upload: (subjectId, formData) =>
    request(`/subjects/${encodeURIComponent(subjectId)}/materials`, {
      method: 'POST', body: formData, // no content-type: the browser sets the boundary
    }),

  summarize: (payload) =>
    request('/summarize', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) }),

  generateFlashcards: (payload) =>
    request('/flashcards/generate', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload),
    }),

  dueFlashcards: () => request('/flashcards/due'),

  reviewFlashcard: (id, quality) =>
    request(`/flashcards/${encodeURIComponent(id)}/review`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ quality }),
    }),

  search: (query) => request(`/search?q=${encodeURIComponent(query)}`),
};

/**
 * Is a backend reachable and are we signed in?
 * Returns `'ready' | 'login' | 'offline'` rather than throwing, because the
 * answer decides what the UI shows, not whether it crashes.
 */
export async function probe() {
  try {
    await api.state();
    return 'ready';
  } catch (error) {
    if (error.unauthorized) return 'login';
    return 'offline';
  }
}
