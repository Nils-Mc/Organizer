/** Tests for the quick-add command input parser and the palette's matching. */
import { parseQuickAdd } from '../web/js/store.js';
import { commandScore } from '../web/js/ui.js';

// 2026-09-08 is a Tuesday.
const TUESDAY = new Date(2026, 8, 8);

export function runQuickAddTests(report) {
  const eq = (actual, expected, name) =>
    report(name, JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const ok = (cond, name, detail = 'expected truthy') => report(name, !!cond, detail);

  // ---- the example from the request ---------------------------------------
  {
    const r = parseQuickAdd('Mathe lernen morgen 18:00 #schule !hoch', TUESDAY);
    eq(r.title, 'Mathe lernen', 'every recognised token is stripped from the title');
    eq(r.dueDate, '2026-09-09', '"morgen" resolves to the next day');
    eq(r.dueTime, '18:00', 'a clock time is picked up');
    eq(r.tags, ['schule'], 'tags still come from the existing tag parser');
    eq(r.priority, 'high', '"!hoch" maps to the high priority');
  }

  // ---- relative days --------------------------------------------------------
  {
    eq(parseQuickAdd('Test heute', TUESDAY).dueDate, '2026-09-08', '"heute" is today');
    eq(parseQuickAdd('Test morgen', TUESDAY).dueDate, '2026-09-09', '"morgen" is tomorrow');
    eq(parseQuickAdd('Test übermorgen', TUESDAY).dueDate, '2026-09-10', '"übermorgen" is in two days');
    eq(parseQuickAdd('Test MORGEN', TUESDAY).dueDate, '2026-09-09', 'keywords are case-insensitive');
    eq(parseQuickAdd('Test morgens joggen', TUESDAY).dueDate, null,
      '"morgens" is a different word and must not be read as a date');
  }

  // ---- weekdays -------------------------------------------------------------
  {
    eq(parseQuickAdd('Abgabe freitag', TUESDAY).dueDate, '2026-09-11',
      'a weekday resolves to the next one');
    eq(parseQuickAdd('Abgabe montag', TUESDAY).dueDate, '2026-09-14',
      'a weekday already past this week rolls into the next');
    eq(parseQuickAdd('Abgabe dienstag', TUESDAY).dueDate, '2026-09-15',
      'naming today\'s weekday means next week, not in a few minutes');
  }

  // ---- explicit dates -------------------------------------------------------
  {
    eq(parseQuickAdd('Termin 12.09.', TUESDAY).dueDate, '2026-09-12', 'day.month. parses');
    eq(parseQuickAdd('Termin 1.10.', TUESDAY).dueDate, '2026-10-01', 'single digits parse');
    eq(parseQuickAdd('Termin 03.02.2027', TUESDAY).dueDate, '2027-02-03', 'an explicit year is kept');
    eq(parseQuickAdd('Termin 01.03.', TUESDAY).dueDate, '2027-03-01',
      'a bare date already past this year rolls into the next');
    eq(parseQuickAdd('Termin 31.02.', TUESDAY).dueDate, null, 'an impossible date is left alone');
    eq(parseQuickAdd('Termin 12.13.', TUESDAY).dueDate, null, 'month 13 is left alone');
    eq(parseQuickAdd('Termin 31.02.', TUESDAY).title, 'Termin 31.02.',
      'an unparsed date stays in the title rather than vanishing');
  }

  // ---- times ----------------------------------------------------------------
  {
    eq(parseQuickAdd('Lernen 18:00', TUESDAY).dueTime, '18:00', 'colon times parse');
    eq(parseQuickAdd('Lernen 18.00', TUESDAY).dueTime, '18:00', 'dot times parse');
    eq(parseQuickAdd('Lernen 9:05', TUESDAY).dueTime, '09:05', 'a single-digit hour is padded');
    eq(parseQuickAdd('Lernen 18h', TUESDAY).dueTime, '18:00', '"18h" is a whole hour');
    eq(parseQuickAdd('Lernen 25:00', TUESDAY).dueTime, null, 'an impossible hour is rejected');
    eq(parseQuickAdd('Lernen 12:75', TUESDAY).dueTime, null, 'an impossible minute is rejected');
    eq(parseQuickAdd('Lernen 25:00', TUESDAY).title, 'Lernen 25:00',
      'a rejected time stays in the title');

    // A time on its own still needs a day to sit on.
    const bare = parseQuickAdd('Anrufen 16:00', TUESDAY);
    eq(bare.dueDate, '2026-09-08', 'a bare time is anchored to today');
  }

  // ---- date and time together must not fight over the same digits -----------
  {
    const r = parseQuickAdd('Termin 12.09. 18:00', TUESDAY);
    eq(r.dueDate, '2026-09-12', 'the trailing dot marks the date half');
    eq(r.dueTime, '18:00', 'the colon marks the time half');
    eq(r.title, 'Termin', 'both are removed from the title');
  }

  // ---- priorities -----------------------------------------------------------
  {
    eq(parseQuickAdd('X !hoch', TUESDAY).priority, 'high', '!hoch');
    eq(parseQuickAdd('X !niedrig', TUESDAY).priority, 'low', '!niedrig');
    eq(parseQuickAdd('X !normal', TUESDAY).priority, 'normal', '!normal');
    eq(parseQuickAdd('X !wichtig', TUESDAY).priority, 'high', 'a synonym maps too');
    eq(parseQuickAdd('X !quatsch', TUESDAY).priority, null, 'an unknown word is not a priority');
    eq(parseQuickAdd('X !quatsch', TUESDAY).title, 'X !quatsch',
      'an unknown priority word stays in the title');
    eq(parseQuickAdd('X', TUESDAY).priority, null,
      'no priority given means the form default decides, not the parser');
  }

  // ---- nothing to parse -----------------------------------------------------
  {
    const plain = parseQuickAdd('Einfach nur ein Titel', TUESDAY);
    eq(plain.title, 'Einfach nur ein Titel', 'a plain title survives untouched');
    eq([plain.dueDate, plain.dueTime, plain.priority], [null, null, null],
      'a plain title sets no fields');
    eq(parseQuickAdd('', TUESDAY).title, '', 'empty input is handled');
    eq(parseQuickAdd(null, TUESDAY).title, '', 'null input is handled');
    ok(!parseQuickAdd(undefined, TUESDAY).dueDate, 'undefined input is handled');
  }

  // ---- only the first mention of a kind counts -------------------------------
  {
    const r = parseQuickAdd('Plan morgen heute', TUESDAY);
    eq(r.dueDate, '2026-09-09', 'the first date wins');
    eq(r.title, 'Plan heute', 'the second date is left in the title as written');
  }

  // ---- command palette matching ----------------------------------------------
  {
    const best = (query, candidates) => candidates
      .map((label) => ({ label, score: commandScore(query, label) }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score)[0];

    ok(commandScore('hut', 'Heute') >= 0, 'letters in order match without being adjacent');
    ok(commandScore('heute', 'Heute') > commandScore('hut', 'Heute'),
      'a closer match scores higher than a sparse one');
    eq(commandScore('xyz', 'Heute'), -1, 'letters that are not there do not match');
    eq(commandScore('', 'Heute'), 0, 'an empty query matches everything equally');
    ok(commandScore('HEU', 'heute') >= 0, 'matching ignores case');

    eq(best('erle', ['Heute', 'Erledigt', 'Alle offenen']).label, 'Erledigt',
      'a typed prefix lands on the obvious command');
    eq(best('ein', ['Eingang', 'Alle offenen', 'Erledigt']).label, 'Eingang',
      'a word-start match beats an incidental one');
    eq(best('mathe', ['Mathe Hausaufgaben', 'Mathematik']).label, 'Mathematik',
      'when two match equally well, the shorter one wins');
    eq(best('mathe', ['Mathematik', 'Mal etwas anderes hier']).label, 'Mathematik',
      'contiguous letters beat the same letters scattered across a sentence');
  }
}
