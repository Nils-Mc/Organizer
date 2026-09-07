/**
 * Worker entry point: static assets, JSON API, scheduled sync, transcription queue.
 *
 * Every /api route except /api/login requires a session. Anything that reaches
 * WebUntis or Workers AI runs here, never in the browser.
 */

import { createDb } from './db.js';
import { UntisClient } from './untis.js';
import { runSync } from './sync.js';
import {
  isAuthenticated, createToken, sessionCookie, clearCookie, hashPassword,
} from './auth.js';
import { joinTranscripts } from './srs.js';

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });

const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

/** Local development runs over plain http, where a Secure cookie never sticks. */
const isLocal = (url) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

function untisFor(env) {
  return new UntisClient({
    host: env.UNTIS_HOST,
    school: env.UNTIS_SCHOOL,
    user: env.UNTIS_USER,
    password: env.UNTIS_PASSWORD,
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleApi(request, env, ctx, url) {
  const db = createDb(env.DB);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  // ---- login is the only unauthenticated route -------------------------
  if (path === '/login' && method === 'POST') {
    const body = await readJson(request);
    const supplied = body && typeof body.password === 'string' ? body.password : '';
    const hash = await hashPassword(supplied, env.PASSWORD_SALT || 'organizer');

    if (!env.PASSWORD_HASH || hash !== env.PASSWORD_HASH) {
      // Deliberately vague: no hint about which part was wrong.
      return json({ error: 'Anmeldung fehlgeschlagen.' }, { status: 401 });
    }
    const token = await createToken(env.SESSION_SECRET);
    return json({ ok: true }, {
      headers: { 'set-cookie': sessionCookie(token, { secure: !isLocal(url) }) },
    });
  }

  if (path === '/logout' && method === 'POST') {
    return json({ ok: true }, {
      headers: { 'set-cookie': clearCookie({ secure: !isLocal(url) }) },
    });
  }

  if (!(await isAuthenticated(request, env))) {
    return json({ error: 'Nicht angemeldet.' }, { status: 401 });
  }

  // ---- overview ---------------------------------------------------------
  if (path === '/state' && method === 'GET') {
    const from = today();
    const to = new Date();
    to.setDate(to.getDate() + 28);
    const [subjects, lessons, homework, exams, lastSync] = await Promise.all([
      db.subjectsWithCounts(),
      db.lessonsBetween(from, to.toISOString().slice(0, 10)),
      db.openHomework(),
      db.upcomingExams(from),
      db.getSyncState('last_sync'),
    ]);
    return json({ subjects, lessons, homework, exams, lastSync });
  }

  // ---- sync on demand ----------------------------------------------------
  if (path === '/sync' && method === 'POST') {
    try {
      const result = await runSync({ client: untisFor(env), db });
      return json(result);
    } catch (error) {
      return json({ error: String(error.message || error) }, { status: 502 });
    }
  }

  // ---- homework ----------------------------------------------------------
  const homeworkMatch = path.match(/^\/homework\/([^/]+)$/);
  if (homeworkMatch && method === 'PATCH') {
    const body = await readJson(request);
    await db.setHomeworkCompleted(homeworkMatch[1], body && body.completed === true);
    return json({ ok: true });
  }

  // ---- notes --------------------------------------------------------------
  const subjectNotes = path.match(/^\/subjects\/([^/]+)\/notes$/);
  if (subjectNotes && method === 'GET') {
    return json({ notes: await db.notesForSubject(subjectNotes[1]) });
  }
  if (subjectNotes && method === 'POST') {
    const body = (await readJson(request)) || {};
    const title = String(body.title || '').trim();
    if (!title) return json({ error: 'Titel fehlt.' }, { status: 400 });

    const now = new Date().toISOString();
    const note = {
      id: uid(),
      subject_id: subjectNotes[1],
      lesson_id: body.lessonId || null,
      title,
      body: String(body.body || ''),
      created_at: now,
      updated_at: now,
    };
    await db.createNote(note);
    await db.indexDocument({
      refId: note.id, kind: 'note', subjectId: note.subject_id,
      title: note.title, body: note.body,
    });
    return json({ note }, { status: 201 });
  }

  const noteMatch = path.match(/^\/notes\/([^/]+)$/);
  if (noteMatch && (method === 'PUT' || method === 'PATCH')) {
    const body = (await readJson(request)) || {};
    const updated_at = new Date().toISOString();
    await db.updateNote(noteMatch[1], {
      title: String(body.title || '').trim(),
      body: String(body.body || ''),
      updated_at,
    });
    await db.indexDocument({
      refId: noteMatch[1], kind: 'note', subjectId: body.subjectId || null,
      title: String(body.title || ''), body: String(body.body || ''),
    });
    return json({ ok: true });
  }
  if (noteMatch && method === 'DELETE') {
    await db.deleteNote(noteMatch[1]);
    return json({ ok: true });
  }

  // ---- materials ----------------------------------------------------------
  const subjectMaterials = path.match(/^\/subjects\/([^/]+)\/materials$/);
  if (subjectMaterials && method === 'GET') {
    return json({ materials: await db.materialsForSubject(subjectMaterials[1]) });
  }
  if (subjectMaterials && method === 'POST') {
    // R2 is optional: without it the rest of the app still works, so say what
    // is missing rather than failing on an undefined binding.
    if (!env.BUCKET) {
      return json({
        error: 'Uploads sind nicht aktiv: R2 ist für diesen Account noch nicht ' +
               'freigeschaltet. Siehe die Anleitung in wrangler.toml.',
      }, { status: 503 });
    }
    const subjectId = subjectMaterials[1];
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return json({ error: 'Keine Datei empfangen.' }, { status: 400 });
    }

    const kind = String(form.get('kind') || (file.type.startsWith('audio/') ? 'audio' : 'document'));
    const id = uid();
    const r2Key = `${subjectId}/${id}-${file.name}`;
    await env.BUCKET.put(r2Key, file.stream(), {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    });

    const material = {
      id,
      subject_id: subjectId,
      lesson_id: form.get('lessonId') || null,
      kind,
      filename: file.name,
      r2_key: r2Key,
      mime: file.type || null,
      size_bytes: file.size ?? null,
      chunk_index: Number(form.get('chunkIndex') || 0),
      chunk_group: form.get('chunkGroup') || null,
      status: kind === 'audio' ? 'transcribing' : 'stored',
      created_at: new Date().toISOString(),
    };
    await db.createMaterial(material);

    // Transcription is slow; hand it to the queue so the upload returns now.
    if (kind === 'audio' && env.TRANSCRIBE_QUEUE) {
      await env.TRANSCRIBE_QUEUE.send({ materialId: id });
    }
    return json({ material }, { status: 201 });
  }

  // ---- AI ------------------------------------------------------------------
  if (path === '/summarize' && method === 'POST') {
    const body = (await readJson(request)) || {};
    const ai = await import('./ai.js');
    const now = new Date().toISOString();

    let result;
    if (body.materialId) {
      const material = await db.getMaterial(body.materialId);
      if (!material) return json({ error: 'Material nicht gefunden.' }, { status: 404 });

      if (material.kind === 'audio') {
        const transcript = await db.transcriptFor(material.id);
        if (!transcript) return json({ error: 'Noch keine Transkription.' }, { status: 409 });
        result = await ai.summarizeText(env, { text: transcript.text, subject: body.subject });
      } else {
        if (!env.BUCKET) {
          return json({ error: 'Dokumente sind nicht verfügbar: R2 ist nicht aktiv.' }, { status: 503 });
        }
        const object = await env.BUCKET.get(material.r2_key);
        const buffer = await object.arrayBuffer();
        try {
          result = await ai.summarizeDocument(env, {
            base64: base64FromBuffer(buffer),
            filename: material.filename,
            mime: material.mime,
            subject: body.subject,
          });
        } catch (error) {
          return json({ error: String(error.message || error) }, { status: 502 });
        }
      }
    } else if (body.text) {
      result = await ai.summarizeText(env, { text: body.text, subject: body.subject });
    } else {
      return json({ error: 'Weder Text noch Material angegeben.' }, { status: 400 });
    }

    const summary = {
      id: uid(),
      target_type: body.materialId ? 'material' : 'note',
      target_id: body.materialId || body.noteId || 'ad-hoc',
      model: result.model,
      body: result.body,
      created_at: now,
    };
    await db.saveSummary(summary);
    return json({ summary });
  }

  if (path === '/flashcards/generate' && method === 'POST') {
    const body = (await readJson(request)) || {};
    if (!body.text) return json({ error: 'Kein Text angegeben.' }, { status: 400 });
    const ai = await import('./ai.js');
    const cards = await ai.generateFlashcards(env, { text: body.text, subject: body.subject });
    return json({ cards });
  }

  // ---- search ---------------------------------------------------------------
  if (path === '/search' && method === 'GET') {
    const query = url.searchParams.get('q');
    if (!query || !query.trim()) return json({ results: [] });
    return json({ results: await db.searchKeyword(query.trim()) });
  }

  return json({ error: 'Unbekannter Endpunkt.' }, { status: 404 });
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked to avoid blowing the argument limit on a large PDF.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (error) {
        console.error('API error', error);
        return json({ error: 'Interner Fehler.' }, { status: 500 });
      }
    }
    // Everything else is the static app.
    return env.ASSETS.fetch(request);
  },

  /** Cron-driven sync. Configured in wrangler.toml. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const result = await runSync({ client: untisFor(env), db: createDb(env.DB) });
        console.log('sync ok', JSON.stringify(result));
      } catch (error) {
        console.error('sync failed', error);
      }
    })());
  },

  /** Transcription workers. One message per uploaded audio chunk. */
  async queue(batch, env) {
    const db = createDb(env.DB);
    const ai = await import('./ai.js');

    for (const message of batch.messages) {
      try {
        const material = await db.getMaterial(message.body.materialId);
        if (!material) { message.ack(); continue; }

        const object = await env.BUCKET.get(material.r2_key);
        const { text, language } = await ai.transcribe(env, await object.arrayBuffer());

        await db.saveTranscript({
          id: uid(), material_id: material.id, text, language,
          created_at: new Date().toISOString(),
        });
        await db.setMaterialStatus(material.id, 'done');

        // Once every chunk of a recording is in, index the stitched transcript.
        if (material.chunk_group) {
          const siblings = await db.materialsForSubject(material.subject_id);
          const group = siblings.filter((m) => m.chunk_group === material.chunk_group);
          if (group.every((m) => m.status === 'done')) {
            const parts = await Promise.all(group.map(async (m) => ({
              chunk_index: m.chunk_index,
              text: (await db.transcriptFor(m.id))?.text || '',
            })));
            await db.indexDocument({
              refId: material.chunk_group,
              kind: 'transcript',
              subjectId: material.subject_id,
              title: material.filename,
              body: joinTranscripts(parts),
            });
          }
        } else {
          await db.indexDocument({
            refId: material.id, kind: 'transcript', subjectId: material.subject_id,
            title: material.filename, body: text,
          });
        }
        message.ack();
      } catch (error) {
        console.error('transcription failed', error);
        await createDb(env.DB).setMaterialStatus(message.body.materialId, 'failed').catch(() => {});
        message.retry();
      }
    }
  },
};
