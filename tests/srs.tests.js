/** Tests for transcript stitching, SM-2 scheduling and JSON extraction. */
import { joinTranscripts, schedule, extractJson } from '../worker/src/srs.js';

const NOW = new Date(2026, 8, 7); // 2026-09-07, local

export function runSrsTests(report) {
  const eq = (actual, expected, name) =>
    report(name, JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const ok = (cond, name, detail = 'expected truthy') => report(name, !!cond, detail);

  // ---- joinTranscripts ---------------------------------------------------
  eq(joinTranscripts([
    { chunk_index: 2, text: 'drittens' },
    { chunk_index: 0, text: 'erstens' },
    { chunk_index: 1, text: 'zweitens' },
  ]), 'erstens\n\nzweitens\n\ndrittens',
    'chunks are stitched by index, not by arrival order');

  eq(joinTranscripts([
    { chunk_index: 0, text: '  padded  ' },
    { chunk_index: 1, text: '   ' },
    { chunk_index: 2, text: 'end' },
  ]), 'padded\n\nend', 'blank chunks are dropped and text is trimmed');

  eq(joinTranscripts([]), '', 'no chunks yields an empty transcript');
  eq(joinTranscripts(null), '', 'joinTranscripts tolerates null');
  eq(joinTranscripts([{ text: 'a' }, { text: 'b' }]), 'a\n\nb',
    'chunks without an index keep their given order');

  // ---- SM-2: the successful ladder ----------------------------------------
  {
    const first = schedule({}, 5, NOW);
    eq(first.interval_days, 1, 'a brand-new card is first repeated after one day');
    eq(first.repetitions, 1, 'the first success counts as one repetition');
    eq(first.due_at, '2026-09-08', 'the due date is one day out');
    ok(first.ease > 2.5, 'a perfect answer raises the ease factor');

    const second = schedule(first, 5, NOW);
    eq(second.interval_days, 6, 'the second success jumps to six days');
    eq(second.due_at, '2026-09-13', 'the due date follows the six-day interval');

    const third = schedule(second, 5, NOW);
    eq(third.repetitions, 3, 'repetitions keep counting');
    ok(third.interval_days > 6, 'from the third success the interval multiplies by ease');
    eq(third.interval_days, Math.round(6 * second.ease),
      'the third interval is the previous one times the ease factor');
  }

  // ---- SM-2: lapses --------------------------------------------------------
  {
    const mature = { interval_days: 30, repetitions: 5, ease: 2.5, lapses: 0 };
    const lapsed = schedule(mature, 1, NOW);
    eq(lapsed.interval_days, 1, 'a failed card returns to a one-day interval');
    eq(lapsed.repetitions, 0, 'a failed card resets its repetition count');
    eq(lapsed.lapses, 1, 'the lapse is recorded');
    ok(lapsed.ease < 2.5, 'a failure lowers the ease factor');
    eq(lapsed.due_at, '2026-09-08', 'a lapsed card comes back tomorrow');

    // Quality 3 is the boundary: a pass, not a lapse.
    const barely = schedule(mature, 3, NOW);
    eq(barely.lapses, 0, 'quality 3 is not a lapse');
    eq(barely.repetitions, 6, 'quality 3 still advances the repetition count');
    ok(barely.ease < 2.5, 'a hard pass still lowers the ease');
  }

  // ---- SM-2: the ease floor -------------------------------------------------
  {
    let card = { interval_days: 10, repetitions: 4, ease: 1.3, lapses: 3 };
    for (let i = 0; i < 5; i++) card = { ...card, ...schedule(card, 0, NOW) };
    ok(card.ease >= 1.3, 'ease never falls below the SM-2 floor of 1.3');
    eq(card.ease, 1.3, 'repeated failures pin ease exactly at the floor');
    eq(card.lapses, 8, 'every failure is counted on top of the existing three');
  }

  // ---- input hardening -------------------------------------------------------
  {
    eq(schedule({}, 99, NOW).interval_days, 1, 'an out-of-range quality is clamped high');
    eq(schedule({ interval_days: 9, repetitions: 3, ease: 2.5 }, -5, NOW).interval_days, 1,
      'an out-of-range quality is clamped low and counts as a lapse');
    eq(schedule({}, undefined, NOW).lapses, 1, 'a missing quality is treated as a failure');
  }

  // ---- extractJson ------------------------------------------------------------
  // Workers AI's guided_json is silently ignored once `messages` is set, so the
  // model's actual output — a bare array, sometimes fenced, sometimes not — is
  // what this has to handle, not the schema-shaped object the docs promise.
  {
    eq(extractJson('[{"front":"a","back":"b"}]'), [{ front: 'a', back: 'b' }],
      'a bare JSON array parses directly');
    eq(extractJson('```json\n[{"front":"a","back":"b"}]\n```'), [{ front: 'a', back: 'b' }],
      'a ```json fence around an array is stripped');
    eq(extractJson('```\n[{"front":"a","back":"b"}]\n```'), [{ front: 'a', back: 'b' }],
      'a bare ``` fence with no language tag is stripped too');
    eq(extractJson('  \n [1,2,3] \n  '), [1, 2, 3], 'surrounding whitespace is trimmed');
    eq(extractJson('{"cards":[{"front":"a","back":"b"}]}'), { cards: [{ front: 'a', back: 'b' }] },
      'an object-wrapped shape still parses, in case the model does honour guided_json');

    // Empirically, the binding sometimes hands back an already-parsed value
    // instead of a string — passing that through String() first would stringify
    // it as "[object Object]" and break parsing, so identity has to win first.
    const already = [{ front: 'a', back: 'b' }];
    eq(extractJson(already), already, 'an already-parsed array is returned as-is, not re-stringified');
    const alreadyObj = { cards: [{ front: 'a', back: 'b' }] };
    eq(extractJson(alreadyObj), alreadyObj, 'an already-parsed object is returned as-is too');

    let threw = null;
    try { extractJson('not json at all'); } catch (e) { threw = e; }
    ok(threw, 'unparsable text throws rather than returning a bogus value');

    threw = null;
    try { extractJson(''); } catch (e) { threw = e; }
    ok(threw, 'empty input throws rather than returning a bogus value');
  }
}
