/**
 * AI features: transcription, summaries and flashcards — all on Workers AI.
 *
 * No external API key: Workers AI is already bound as env.AI (used here for
 * Whisper too), billed against the same free daily Neuron allocation as
 * everything else in the account, no separate credentials to hold.
 *
 * Prompts are in German because the source material is.
 */

// Pure helpers live in srs.js so they stay testable without a Workers AI binding.
// Re-exported for callers of ai.js, and imported below since `export ... from`
// re-exports a name without binding it locally — this module uses extractJson
// itself, so it needs its own import too.
export { joinTranscripts, schedule, extractJson } from './srs.js';
import { extractJson } from './srs.js';

const WHISPER = '@cf/openai/whisper-large-v3-turbo';

// Mistral Small 3.1 24B: not on the small list of models that require Workers
// Paid (kimi-k2.x, glm-5.2), supports the `guided_json` param flashcards rely
// on, and is one of the stronger Workers AI models at following instructions
// in German. Quality is a real step down from Claude — that trade was made
// deliberately in exchange for zero API cost.
export const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

/** Transcribe one audio chunk. Returns `{text, language}`. */
export async function transcribe(env, bytes) {
  const result = await env.AI.run(WHISPER, {
    audio: [...new Uint8Array(bytes)],
    // Untis lessons are German; naming it beats letting Whisper guess badly on
    // a noisy classroom recording.
    language: 'de',
  });
  return {
    text: (result && (result.text || result.transcription) || '').trim(),
    language: 'de',
  };
}

const SUMMARY_SYSTEM = `Du fasst Unterrichtsmaterial für eine Schülerin oder einen Schüler zusammen.

Regeln:
- Schreibe auf Deutsch, in Markdown.
- Beginne mit 2-3 Sätzen Kernaussage, dann die wichtigsten Punkte als Liste.
- Hebe Definitionen, Formeln und Termine gesondert hervor.
- Erfinde nichts. Wenn das Material unvollständig oder unverständlich ist, sage das.
- Keine Einleitungsfloskeln wie "Hier ist die Zusammenfassung".`;

/** Summarize a transcript or pasted text. */
export async function summarizeText(env, { text, subject, kind = 'Mitschrift' }) {
  const result = await env.AI.run(MODEL, {
    max_tokens: 2048,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `Fach: ${subject || 'unbekannt'}\nArt: ${kind}\n\n${text}` },
    ],
  });
  return { model: MODEL, body: (result.response || '').trim() };
}

/**
 * Summarize a PDF or other uploaded document. Workers AI text models take
 * plain text only — no native PDF reading the way Claude has — so the file
 * first goes through Workers AI's own `toMarkdown` conversion (also handles
 * images, HTML, docx, ...), then the extracted text is summarized like any
 * other text.
 */
export async function summarizeDocument(env, { base64, filename, subject, mime }) {
  const bytes = Buffer.from(base64, 'base64');
  const [converted] = await env.AI.toMarkdown([
    { name: filename || 'dokument', blob: new Blob([bytes], { type: mime || 'application/octet-stream' }) },
  ]);

  if (!converted || converted.format === 'error') {
    throw new Error(
      `Dokument konnte nicht gelesen werden${converted && converted.error ? `: ${converted.error}` : '.'}`
    );
  }

  return summarizeText(env, { text: converted.data, subject, kind: 'Dokument' });
}

/**
 * Generate flashcards. The model is asked for a plain JSON array — the
 * shape it naturally produces — rather than an object wrapper, since
 * `guided_json` does not hold in chat mode (see extractJson in srs.js).
 * Every card is validated before being returned; a card missing a usable
 * front or back is dropped rather than shown as an empty tile in the UI.
 */
export async function generateFlashcards(env, { text, subject, count = 12 }) {
  const result = await env.AI.run(MODEL, {
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: `Du erstellst Lernkarten aus Unterrichtsmaterial. Deutsch, präzise, eine Sache pro Karte.
Keine Ja/Nein-Fragen. Die Rückseite muss ohne die Vorderseite verständlich sein.
Antworte ausschließlich mit einem JSON-Array aus Objekten der Form {"front": "...", "back": "..."} — kein Fließtext, kein Objekt-Wrapper.`,
      },
      { role: 'user', content: `Fach: ${subject || 'unbekannt'}\nErstelle höchstens ${count} Lernkarten aus:\n\n${text}` },
    ],
  });

  try {
    const parsed = extractJson(result.response || '');
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cards) ? parsed.cards : [];
    return list
      .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string' && c.front.trim() && c.back.trim())
      .slice(0, count);
  } catch (error) {
    // A parse failure degrades to an empty list for the UI, but must not
    // vanish silently — this is the only signal that the model drifted to a
    // shape extractJson doesn't yet handle.
    console.error('generateFlashcards: could not parse model output', error, result.response);
    return [];
  }
}
