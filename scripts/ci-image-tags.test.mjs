import assert from 'node:assert/strict';
import test from 'node:test';
import { imagePlan } from './ci-image-tags.mjs';

const base = {
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40), DEFAULT_BRANCH: 'main', DOCKERHUB_IMAGE: 'example/intent-crm',
  DOCKERHUB_PUBLISH_ENABLED: 'true',
};
const shaTag = `example/intent-crm:sha-${base.GITHUB_SHA}`;

test('PR builds without publication or Docker Hub configuration', () => {
  const plan = imagePlan({ ...base, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge', DOCKERHUB_IMAGE: '', MANUAL_PUSH: 'true' });
  assert.equal(plan.publish, false);
  assert.deepEqual(plan.tags, [`local/intent-crm:sha-${base.GITHUB_SHA}`]);
});

test('main publishes edge and the exact commit when repository publication is enabled', () => {
  assert.deepEqual(imagePlan(base), { publish: true, tags: ['example/intent-crm:edge', shaTag] });
});

test('main, release tags, and manual requests build without repository publication opt-in', () => {
  const events = [
    {},
    { GITHUB_REF: 'refs/tags/v1.2.3' },
    { GITHUB_REF: 'refs/tags/v1.2.3-rc.1' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', MANUAL_PUSH: 'true' },
  ];
  for (const event of events) {
    for (const enabled of [undefined, '', 'false', 'TRUE', '1']) {
      for (const image of ['', 'example/intent-crm']) {
        const plan = imagePlan({ ...base, ...event, DOCKERHUB_PUBLISH_ENABLED: enabled, DOCKERHUB_IMAGE: image });
        assert.equal(plan.publish, false);
        assert.ok(plan.tags.every(tag => tag.startsWith(`${image || 'local/intent-crm'}:`)));
        assert.ok(plan.tags.includes(`${image || 'local/intent-crm'}:sha-${base.GITHUB_SHA}`));
      }
    }
  }
});

test('stable version publishes version, minor alias and latest', () => {
  assert.deepEqual(imagePlan({ ...base, GITHUB_REF: 'refs/tags/v1.2.3' }), {
    publish: true, tags: ['example/intent-crm:1.2.3', shaTag, 'example/intent-crm:1.2', 'example/intent-crm:latest'],
  });
});

test('prerelease cannot overwrite latest or a stable minor alias', () => {
  assert.deepEqual(imagePlan({ ...base, GITHUB_REF: 'refs/tags/v1.2.3-rc.1' }), {
    publish: true, tags: ['example/intent-crm:1.2.3-rc.1', shaTag],
  });
});

test('manual publication requires both opt-in and the actual default branch', () => {
  const manual = { ...base, GITHUB_EVENT_NAME: 'workflow_dispatch' };
  assert.equal(imagePlan(manual).publish, false);
  assert.equal(imagePlan({ ...manual, MANUAL_PUSH: 'false' }).publish, false);
  assert.equal(imagePlan({ ...manual, MANUAL_PUSH: 'true' }).publish, true);
  assert.equal(imagePlan({ ...manual, GITHUB_REF: 'refs/heads/feature', MANUAL_PUSH: 'true' }).publish, false);
  assert.equal(imagePlan({ ...manual, GITHUB_REF: 'refs/tags/v1.2.3', MANUAL_PUSH: 'true' }).publish, false);
  assert.equal(imagePlan({ ...manual, DEFAULT_BRANCH: '', MANUAL_PUSH: 'true' }).publish, false);
  assert.equal(imagePlan({ ...manual, DEFAULT_BRANCH: 'trunk', GITHUB_REF: 'refs/heads/trunk', MANUAL_PUSH: 'true' }).publish, true);
});

test('publication requires a complete image namespace/repository without a registry or tag', () => {
  for (const image of ['', 'repo', 'docker.io/ns/repo', 'ns/repo:latest', 'ns/repo@sha256:123', 'ns/repo\nBAD=true']) {
    assert.throws(() => imagePlan({ ...base, DOCKERHUB_IMAGE: image }));
  }
});

test('malformed release tags cannot publish', () => {
  for (const tag of ['v01.2.3', 'v1.2.3+build', 'v1.2.3-01', 'v1.2.3-', 'v1.2.3\nlatest']) {
    assert.throws(() => imagePlan({ ...base, GITHUB_REF: `refs/tags/${tag}` }));
  }
});
