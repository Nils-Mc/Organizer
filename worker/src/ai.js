/**
 * AI features: transcription (Workers AI / Whisper) and summaries plus
 * flashcards (Claude).
 *
 * Prompts are in German because the source material is.
 */

import Anthropic from '@anthropic-ai/sdk';

// Pure helpers live in srs.js so they stay testable without the SDK installed.
export { joinTranscripts, schedule } from './srs.js';

export const MODEL = 'claude-opus-5';
const WHISPER = '@cf/openai/whisper-large-v3-turbo';

function client(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * Claude Opus 5 can decline a request; the server-side fallback re-routes those
 * by category instead of handing the caller an empty response.
 */
const FALLBACK = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

/** Pull the plain text out of a response, ignoring thinking blocks. */
function textOf(message) {
  return (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

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
  const message = await client(env).beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: SUMMARY_SYSTEM,
    messages: [{
      role: 'user',
      content: `Fach: ${subject || 'unbekannt'}\nArt: ${kind}\n\n${text}`,
    }],
    ...FALLBACK,
  });
  return { model: MODEL, body: textOf(message) };
}

/**
 * Summarize a PDF. Claude reads PDFs natively as a document block, so there is
 * no PDF parser in this codebase and no text-extraction step to go wrong.
 */
export async function summarizeDocument(env, { base64, filename, subject, mime }) {
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(filename || '');
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'text', text: atob(base64) };

  const message = await client(env).beta.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: SUMMARY_SYSTEM,
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: `Fach: ${subject || 'unbekannt'}\nFasse dieses Dokument zusammen.` }],
    }],
    ...FALLBACK,
  });
  return { model: MODEL, body: textOf(message) };
}

const FLASHCARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['front', 'back'],
        properties: {
          front: { type: 'string', description: 'Die Frage oder der Begriff' },
          back: { type: 'string', description: 'Die Antwort, knapp und vollständig' },
        },
      },
    },
  },
};

/**
 * Generate flashcards. Uses structured outputs so the result is guaranteed to
 * parse — no regex over prose, no half-written JSON.
 */
export async function generateFlashcards(env, { text, subject, count = 12 }) {
  const message = await client(env).beta.messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    system: `Du erstellst Lernkarten aus Unterrichtsmaterial. Deutsch, präzise, eine Sache pro Karte.
Keine Ja/Nein-Fragen. Die Rückseite muss ohne die Vorderseite verständlich sein.`,
    messages: [{
      role: 'user',
      content: `Fach: ${subject || 'unbekannt'}\nErstelle höchstens ${count} Lernkarten aus:\n\n${text}`,
    }],
    output_config: {
      format: { type: 'json_schema', schema: FLASHCARD_SCHEMA },
    },
    ...FALLBACK,
  });

  try {
    const parsed = JSON.parse(textOf(message));
    return Array.isArray(parsed.cards) ? parsed.cards : [];
  } catch {
    return [];
  }
}
