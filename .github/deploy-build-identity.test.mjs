import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The build identity generator calls plain `git describe`, not `git
// describe --always`. A checkout with only the current commit lacks the
// annotated tags and ancestry it needs. The normal CI workflow uses full
// history, but the deployment job independently checks out its own copy.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github/workflows/web-deploy.yml'), 'utf8');

function deployJob(yaml) {
  return yaml.split(/^  deploy:\s*$/m)[1]?.split(/^  [A-Za-z0-9_-]+:\s*$/m)[0] ?? '';
}

function deployCheckoutDepth(yaml) {
  const steps = deployJob(yaml).split(/^      - /m);
  const checkout = steps.find((step) => /^uses: actions\/checkout@v\d+\s*$/m.test(step));
  return checkout?.match(/^          fetch-depth: (\d+)\s*$/m)?.[1] ?? null;
}

test('deployment checkout fetches history and tags for build identity', () => {
  assert.equal(deployCheckoutDepth(workflow), '0',
    'the deploy job must use fetch-depth: 0 so git describe can see annotated tags');
});

test('the checkout guard rejects a shallow deployment', () => {
  assert.equal(deployCheckoutDepth(workflow.replace('fetch-depth: 0', 'fetch-depth: 1')), '1');
  assert.notEqual(deployCheckoutDepth(workflow.replace('fetch-depth: 0', 'fetch-depth: 1')), '0');
  assert.equal(deployCheckoutDepth(workflow.replace('          fetch-depth: 0\n', '')), null);
});

test('deployment verifies the exact Git metadata required by the builder', () => {
  const job = deployJob(workflow);
  assert.match(job, /^      - name: Verify checkout provenance\s*$/m);
  assert.match(job, /^          test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"\s*$/m);
  assert.match(job, /^          git describe\s*$/m);
  assert.match(job, /^          git show -s --format=%cI "\$GITHUB_SHA"\s*$/m);
});
