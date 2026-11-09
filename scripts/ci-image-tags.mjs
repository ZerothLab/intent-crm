import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function imagePlan(env) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha, DEFAULT_BRANCH: defaultBranch } = env;
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'Expected the checked-out GitHub commit SHA');
  let publish = false;
  const tags = [`sha-${sha}`];
  if (event === 'push' && ref === 'refs/heads/main') {
    publish = true;
    tags.unshift('edge');
  } else if (event === 'push' && ref?.startsWith('refs/tags/')) {
    // Deliberately reject malformed release tags and SemVer build metadata.
    const match = /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(ref);
    assert.ok(match, 'Release tag must be vX.Y.Z or vX.Y.Z-prerelease');
    const prerelease = match[4];
    assert.ok(!prerelease?.split('.').some(part => /^\d+$/.test(part) && /^0\d/.test(part)), 'Prerelease numbers cannot have leading zeros');
    const version = ref.slice('refs/tags/v'.length);
    assert.ok(version.length <= 128, 'Release tag exceeds Docker tag length');
    publish = true;
    tags.unshift(version);
    if (!prerelease) tags.push(`${match[1]}.${match[2]}`, 'latest');
  } else if (event === 'workflow_dispatch') {
    const onDefaultBranch = Boolean(defaultBranch) && ref === `refs/heads/${defaultBranch}`;
    publish = env.MANUAL_PUSH === 'true' && onDefaultBranch;
    if (onDefaultBranch) tags.unshift('edge');
  }
  // Publishing source must not implicitly authorize an external registry push.
  publish = publish && env.DOCKERHUB_PUBLISH_ENABLED === 'true';
  const image = env.DOCKERHUB_IMAGE || (publish ? '' : 'local/intent-crm');
  assert.match(image, /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/, 'Set vars.DOCKERHUB_IMAGE to a lowercase Docker Hub namespace/repository (without registry, tag or digest)');
  return { publish, tags: tags.map(tag => `${image}:${tag}`) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = imagePlan(process.env);
  assert.ok(process.env.GITHUB_OUTPUT, 'Run this entry point in GitHub Actions');
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${plan.publish}\ntags=${plan.tags.join(',')}\n`);
  console.log(`${plan.publish ? 'Publish' : 'Build only'}: ${plan.tags.join(', ')}`);
}
