/**
 * Pure helpers that sit next to the AI features but must not depend on them.
 *
 * Kept out of ai.js on purpose: that module imports the Anthropic SDK, and this
 * logic deserves to be testable without installing or stubbing it.
 */

/**
 * Chunks of a long recording are transcribed independently and in parallel, so
 * they can come back out of order — stitch them by index, never by arrival.
 */
export function joinTranscripts(chunks) {
  return [...(chunks || [])]
    .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0))
    .map((c) => String((c && c.text) || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * SM-2 spaced repetition.
 *
 * @param {{interval_days?: number, repetitions?: number, ease?: number, lapses?: number}} card
 * @param {number} quality 0-5; below 3 counts as a lapse
 */
export function schedule(card, quality, now = new Date()) {
  const q = Math.max(0, Math.min(5, Number(quality) || 0));
  let interval = card.interval_days ?? 0;
  let repetitions = card.repetitions ?? 0;
  let ease = card.ease ?? 2.5;
  let lapses = card.lapses ?? 0;

  if (q < 3) {
    // A lapse resets the ladder but keeps the (now lowered) ease factor.
    repetitions = 0;
    interval = 1;
    lapses += 1;
  } else {
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round(interval * ease);
  }

  ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ease < 1.3) ease = 1.3; // the standard SM-2 floor

  const due = new Date(now);
  due.setDate(due.getDate() + interval);
  const pad = (n) => String(n).padStart(2, '0');

  return {
    interval_days: interval,
    repetitions,
    ease: Math.round(ease * 1000) / 1000,
    lapses,
    due_at: `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`,
  };
}
