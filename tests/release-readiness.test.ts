import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const configured: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: 'postgresql://intent:private-password@postgres:5432/intent_crm',
  INTENT_PUBLIC_ORIGIN: 'https://crm.example.test',
  TEMPORAL_ADDRESS: 'temporal.internal:7233',
  TEMPORAL_NAMESPACE: 'default',
  INTENT_ENCRYPTION_KEY: '',
};
const configuration = (values: NodeJS.ProcessEnv = {}, databaseOnly = false) => spawnSync(process.execPath,
  ['scripts/production-config.mjs', ...(databaseOnly ? ['database'] : [])],
  { cwd: root, env: { ...configured, ...values }, encoding: 'utf8' });

test('production preflight permits configured simulation and canonical encrypted integrations', () => {
  assert.equal(configuration().status, 0);
  assert.equal(configuration({ INTENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), TEMPORAL_ADDRESS: '[::1]:7233' }).status, 0);
  assert.equal(configuration({ TEMPORAL_NAMESPACE: undefined }).status, 0);
});

test('production preflight fails before starting services and never prints secrets', () => {
  for (const values of [
    { DATABASE_URL: undefined }, { DATABASE_URL: 'https://user:private-password@postgres/db' },
    { DATABASE_URL: 'postgresql://user:private-password@postgres' },
    { DATABASE_URL: 'postgresql://user:REPLACE_WITH_RANDOM_DATABASE_PASSWORD@postgres/db' },
    { INTENT_PUBLIC_ORIGIN: 'http://crm.example.test' }, { INTENT_PUBLIC_ORIGIN: 'https://crm.example.test/' },
    { INTENT_PUBLIC_ORIGIN: 'https://user:private-password@crm.example.test' },
    { TEMPORAL_ADDRESS: undefined }, { TEMPORAL_ADDRESS: 'http://temporal:7233' },
    { TEMPORAL_ADDRESS: 'temporal:65536' }, { TEMPORAL_ADDRESS: 'temporal:7233/path' },
    { TEMPORAL_ADDRESS: '[bad]:7233' }, { TEMPORAL_ADDRESS: '%:7233' },
    { TEMPORAL_NAMESPACE: ' ' }, { INTENT_ENCRYPTION_KEY: 'private-password' },
    { INTENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64').replace(/=$/, '') },
  ]) {
    const result = configuration(values);
    assert.equal(result.status, 1, JSON.stringify(Object.keys(values)));
    assert.doesNotMatch(result.stderr, /private-password|REPLACE_WITH_RANDOM/);
  }
  const result = spawnSync('sh', ['docker/entrypoint.sh', 'worker'], {
    cwd: root, env: { ...configured, TEMPORAL_ADDRESS: '' }, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEMPORAL_ADDRESS/);
  assert.doesNotMatch(result.stderr, /Temporal connection|ECONNREFUSED/);
});

test('bootstrap and migration validation needs only database configuration', () => {
  assert.equal(configuration({ INTENT_PUBLIC_ORIGIN: undefined, TEMPORAL_ADDRESS: undefined }, true).status, 0);
  assert.equal(configuration({ DATABASE_URL: undefined }, true).status, 1);
});

test('backup publishes a private archive only after dump and archive validation both succeed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'intent-backup-test-'));
  const destination = join(directory, 'backup.dump');
  const docker = join(directory, 'docker');
  writeFileSync(docker, `#!/bin/sh
case "$*" in
  *pg_dump*)
    if [ "$BACKUP_TEST_MODE" != empty ]; then printf 'PGDMP archive data'; fi
    if [ "$BACKUP_TEST_MODE" = dump-failed ]; then exit 2; fi ;;
  *--list*)
    test "$(cat)" = 'PGDMP archive data' || exit 1
    test "$BACKUP_TEST_MODE" != invalid || exit 1
    if [ "$BACKUP_TEST_MODE" = race ]; then printf 'existing backup' > "$BACKUP_TEST_DESTINATION"; fi ;;
  *) exit 3 ;;
esac
`, { mode: 0o700 });
  const backup = (mode = 'success') => spawnSync('sh', ['scripts/backup.sh', destination], {
    cwd: root,
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BACKUP_TEST_MODE: mode, BACKUP_TEST_DESTINATION: destination },
    encoding: 'utf8',
  });
  const noPartial = () => assert.equal(readdirSync(directory).some(name => name.includes('.partial.')), false);
  try {
    for (const mode of ['empty', 'dump-failed', 'invalid']) {
      const result = backup(mode);
      assert.notEqual(result.status, 0, mode);
      assert.equal(readdirSync(directory).includes('backup.dump'), false, mode);
      noPartial();
    }
    const success = backup();
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(destination, 'utf8'), 'PGDMP archive data');
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    noPartial();
    assert.notEqual(backup().status, 0);
    assert.equal(readFileSync(destination, 'utf8'), 'PGDMP archive data');
    rmSync(destination);
    assert.notEqual(backup('race').status, 0);
    assert.equal(readFileSync(destination, 'utf8'), 'existing backup');
    noPartial();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
