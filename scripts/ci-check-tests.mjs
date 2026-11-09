import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guard the existing suite: missing integration configuration must never go green.
assert.ok(process.env.DATABASE_URL, 'CI requires a real PostgreSQL DATABASE_URL');
assert.equal(process.env.INTENT_TEMPORAL_TESTS, '1', 'CI requires the real Temporal integration test');
const report = readFileSync(process.argv[2], 'utf8');
function summary(metric) {
  const values = [...report.matchAll(new RegExp(`^# ${metric} (\\d+)$`, 'gm'))];
  assert.equal(values.length, 1, `Expected one complete TAP ${metric} summary`);
  return Number(values[0][1]);
}
for (const metric of ['fail', 'cancelled', 'skipped', 'todo']) {
  assert.equal(summary(metric), 0, `CI cannot publish with ${metric} tests`);
}
const total = summary('tests');
assert.ok(total > 0, 'CI must execute tests');
assert.equal(summary('pass'), total, 'Every executed test must pass');
assert.doesNotMatch(report, /^\s*not ok \d+\b/m, 'The report must not contain a failed test');
assert.match(report, /^ok \d+ - PostgreSQL domain:/m, 'PostgreSQL integration must pass');
assert.match(report, /^ok \d+ - real Temporal waits after stale approval,/m, 'Temporal integration must pass');
console.log('CI test gate passed: PostgreSQL, Temporal, and zero skipped tests');
