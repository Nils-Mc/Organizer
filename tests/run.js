/** Headless runner: `node tests/run.js`. The browser uses test.html instead. */
import { runTests } from './tests.js';

let passed = 0;
const failures = [];

runTests((name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name} — ${detail}`);
});

for (const failure of failures) console.error('FAIL  ' + failure);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
