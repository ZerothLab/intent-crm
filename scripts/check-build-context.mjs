import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = mkdtempSync(join(root, 'docker', '.context-check-'));
const temporary = mkdtempSync(join(tmpdir(), 'intent-build-context-'));
const secrets = ['.env', '.env.production', '.npmrc', 'secret.pem', 'secret.key', 'debug.log', 'customers.dump', 'customers.backup', 'temporal.sqlite', 'temporal.sqlite-wal', 'temporal.sqlite-shm', 'temporal.sqlite3', 'temporal.sqlite3-wal', 'temporal.sqlite3-shm'];
const privateDirectories = ['node_modules', '.git', '.codex', '.agents', '.aws', '.ssh', '.gnupg', '.kube', '.docker'];
try {
  for (const name of secrets) writeFileSync(join(fixtures, name), 'BUILD_CONTEXT_TEST_SENTINEL');
  for (const name of privateDirectories) {
    mkdirSync(join(fixtures, name));
    writeFileSync(join(fixtures, name, 'private.txt'), 'PRIVATE_DIRECTORY_SENTINEL');
  }
  writeFileSync(join(fixtures, 'included.txt'), 'PUBLIC_CONTEXT_SENTINEL');
  const dockerfile = join(temporary, 'Dockerfile');
  const output = join(temporary, 'output');
  writeFileSync(dockerfile, 'FROM scratch\nCOPY . /context\n');
  const build = spawnSync('docker', ['build', '--file', dockerfile, '--output', `type=local,dest=${output}`, root], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024,
  });
  assert.equal(build.status, 0, build.error?.message ?? build.stderr);
  const context = join(output, 'context');
  const copied = join(context, 'docker', basename(fixtures));
  assert.equal(readFileSync(join(copied, 'included.txt'), 'utf8'), 'PUBLIC_CONTEXT_SENTINEL');
  for (const name of [...secrets, ...privateDirectories]) assert.equal(existsSync(join(copied, name)), false, `${name} must not enter the image build context`);
  for (const name of privateDirectories) assert.equal(existsSync(join(context, name)), false, `${name} must not enter the image build context`);
  console.log('Build context verified: credentials, database archives, local dependencies, and internal records are excluded.');
} finally {
  rmSync(fixtures, { recursive: true, force: true });
  rmSync(temporary, { recursive: true, force: true });
}
