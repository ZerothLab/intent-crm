// Run inside the image with --import tsx, production mounts, and a disposable CI database.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { productionConfigurationErrors } from '../scripts/production-config.mjs';

assert.notEqual(process.getuid(), 0, 'Application image must run as non-root');
assert.deepEqual(productionConfigurationErrors(process.env), []);
assert.equal(process.env.NODE_ENV, 'production');
assert.equal(process.env.INTENT_SERVE_WEB, 'true');
await access(new URL('../apps/web/dist/index.html', import.meta.url));
const { createApi } = await import('../apps/api/src/index.ts');
const { migrate } = await import('../packages/database/src/migrate.ts');
const { app, db, identity } = await createApi();
const workspaceId = `smoke_${randomUUID().replaceAll('-', '')}`;
const password = randomUUID() + randomUUID();
try {
  await migrate(db);
  await identity.bootstrapWorkspace({ workspaceId, workspaceName: 'Container verification', adminName: 'Container operator', email: 'smoke@example.test', password });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (path, options) => fetch(base + path, { ...options, signal: AbortSignal.timeout(10000) });
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/ready')).status, 503, 'A container without a worker must not claim readiness');
  const page = await request('/settings/models');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const html = await page.text();
  const asset = /src="(\/assets\/[^\"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset, 'The compiled web entry must include a JavaScript asset');
  const bundle = await request(asset);
  assert.equal(bundle.status, 200);
  assert.ok((await bundle.text()).length > 100);
  assert.equal((await request('/api/workspace')).status, 401);
  const credentials = JSON.stringify({ workspaceId, email: 'smoke@example.test', password });
  const headers = { 'content-type': 'application/json', origin: process.env.INTENT_PUBLIC_ORIGIN };
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example.test' }, body: credentials })).status, 403);
  assert.equal((await request('/api/dev/session', { method: 'POST', headers, body: '{}' })).status, 403);
  const login = await request('/api/auth/login', { method: 'POST', headers, body: credentials });
  assert.equal(login.status, 201);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /^__Host-intent_session=/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  const workspace = await request('/api/workspace', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(workspace.status, 200);
  assert.equal((await workspace.json()).id, workspaceId);
  assert.equal((await request('/api/not-a-route')).status, 404);
} finally {
  await app.close();
  await db.close();
}
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const { bundleWorkflowCode } = require('@temporalio/worker');
const bundle = await bundleWorkflowCode({
  workflowsPath: new URL('../apps/worker/src/workflows.ts', import.meta.url).pathname,
});
assert.ok(bundle.code, 'Temporal workflow bundle must not be empty');
console.log(`Container smoke passed: ${process.platform}/${process.arch}, uid=${process.getuid()}, migrations, production login, protected API, compiled Web, Temporal workflow bundle`);
