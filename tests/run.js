/** Headless runner: `node tests/run.js`. The browser uses test.html instead. */
import { runTests } from './tests.js';
import { runUntisTests } from './untis.tests.js';
import { runSyncTests } from './sync.tests.js';
import { runAuthTests } from './auth.tests.js';
import { runSrsTests } from './srs.tests.js';
import { runScheduleTests } from './schedule.tests.js';
import { runQuickAddTests } from './quickadd.tests.js';

let passed = 0;
const failures = [];

const report = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name} — ${detail}`);
};

// The app suite is synchronous; the Untis suite ends with async client tests.
runTests(report);
await runUntisTests(report);
await runSyncTests(report);
await runAuthTests(report);
runSrsTests(report);
runScheduleTests(report);
runQuickAddTests(report);

for (const failure of failures) console.error('FAIL  ' + failure);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
