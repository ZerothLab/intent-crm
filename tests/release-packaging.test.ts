import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const passed = `TAP version 13
ok 1 - PostgreSQL domain: integration
ok 2 - real Temporal waits after stale approval, and resumes safely
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 100
`;

function gate(report: string, env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'intent-release-gate-'));
  const path = join(directory, 'tests.tap');
  writeFileSync(path, report);
  try {
    return spawnSync(process.execPath, ['scripts/ci-check-tests.mjs', path], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgresql://ci@localhost/ci', INTENT_TEMPORAL_TESTS: '1', ...env },
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('release gate accepts a complete successful database and workflow test run', () => {
  const result = gate(passed);
  assert.equal(result.status, 0, result.stderr);
});

test('release gate blocks omitted infrastructure, failed tests and incomplete summaries', () => {
  for (const report of [
    passed.replace('PostgreSQL domain:', 'Unit test:'),
    passed.replace('real Temporal waits after stale approval,', 'Unit workflow,'),
    ...['fail', 'cancelled', 'skipped', 'todo'].map(metric => passed.replace(`# ${metric} 0`, `# ${metric} 1`)),
    passed.replace('# pass 2\n', ''),
    passed.replace('# pass 2', '# pass 1'),
    passed.replace('# tests 2', '# tests 0'),
    passed + '# tests 2\n',
    passed + '# pass 2\n',
    passed + '# fail 0\n',
    passed + '  not ok 3 - nested failure\n',
    passed.slice(0, passed.indexOf('# skipped')),
  ]) assert.notEqual(gate(report).status, 0, report);
});

test('release gate requires both PostgreSQL and explicit real Temporal test configuration', () => {
  assert.notEqual(gate(passed, { DATABASE_URL: undefined }).status, 0);
  assert.notEqual(gate(passed, { INTENT_TEMPORAL_TESTS: undefined }).status, 0);
  assert.notEqual(gate(passed, { INTENT_TEMPORAL_TESTS: '0' }).status, 0);
});

test('production supervisor reports an unexpected successful child exit as service failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'intent-supervisor-'));
  try {
    for (const path of ['scripts', 'apps/web/dist', 'apps/api/src', 'apps/worker/src']) mkdirSync(join(directory, path), { recursive: true });
    for (const script of ['start.mjs', 'production-config.mjs']) writeFileSync(join(directory, 'scripts', script), readFileSync(join(root, 'scripts', script)));
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    writeFileSync(join(directory, 'apps/web/dist/index.html'), '<!doctype html>');
    writeFileSync(join(directory, 'apps/api/src/index.ts'), 'process.exit(0);');
    writeFileSync(join(directory, 'apps/worker/src/index.ts'), 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 100);');
    const result = spawnSync(process.execPath, ['scripts/start.mjs'], {
      cwd: directory, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, DATABASE_URL: 'postgresql://ci@localhost/ci', INTENT_PUBLIC_ORIGIN: 'https://crm.example.test', TEMPORAL_ADDRESS: 'temporal:7233', INTENT_ENCRYPTION_KEY: '' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '', 'The fixture must exercise child exit handling rather than a startup error');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
