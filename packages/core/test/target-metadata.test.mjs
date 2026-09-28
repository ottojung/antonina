import assert from 'node:assert/strict';
import test from 'node:test';

import { BoardApi } from '../dist/api.js';
import {
  EXECUTION_TARGET_GUIDANCE,
  defaultExecutionTargetAccessMethod,
  defaultExecutionTargetPersistence,
  executionTargetAccess,
  executionTargetDefect,
  guidancePathDefect,
  parseBoard,
} from '../dist/model.js';

// The descriptive metadata a target carries about itself: what it is, how work
// reaches it, what survives, who cleans up, and where the procedure is written.
// These tests pin the two properties that matter for a shared core API: a target
// registered before any of it existed still reads, and a target that states one
// of these cannot state something its backend or kind contradicts.

const timestamp = '2026-09-27T09:00:00.000Z';

function persistentTarget(overrides = {}) {
  return {
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    status: 'available',
    capabilities: ['network-egress', 'persistent-filesystem'],
    address: 'lubko://phoebe-dev',
    description: 'persistent Lubko workstation',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function ephemeralTarget(overrides = {}) {
  return {
    id: 'github-actions',
    backend: 'github-actions',
    kind: 'ephemeral-environment',
    status: 'available',
    capabilities: ['container-isolation', 'ephemeral-lifetime', 'network-egress'],
    address: null,
    description: 'workflow run per job',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function boardWith(targets) {
  return parseBoard({ schemaVersion: 3, nextIssueNumber: 1, issues: [], resources: [], targets, dispatches: [] });
}

/**
 * A board storage service for one test: it serves the signed log, refuses a
 * write against a stale revision, and hands out the one capability the root
 * credential is created with. The board is created through it, so a signed log
 * carrying a target is what these tests read back rather than a hand-built
 * state object.
 */
function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  let signed = null;
  let revision = 0;
  const etag = () => '"v' + revision + '"';
  return {
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      if (!String(url).endsWith('/store/antonina/board-v2')) return new Response(null, { status: 404 });
      if (method === 'GET') {
        if (signed === null) return new Response(null, { status: 404 });
        return new Response(signed, { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag() } });
      }
      if (method === 'POST') {
        if (signed !== null) return new Response(null, { status: 409 });
        signed = String(init.body);
        revision += 1;
        return new Response(JSON.stringify({ mode: 'capability-write', capability }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'PUT') {
        const headers = new Headers(init.headers);
        if (headers.get('X-Skrynia-Capability') !== capability) {
          return new Response(JSON.stringify({ error: 'invalid capability' }), { status: 403 });
        }
        if (headers.get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = String(init.body);
        revision += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

function api(server) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(timestamp),
    newId: () => 'target-metadata-' + ++sequence,
  });
}

test('a target that states nothing descriptive reads through its backend and kind', () => {
  const host = executionTargetAccess(persistentTarget());
  const runner = executionTargetAccess(ephemeralTarget());
  // The two are not the same shape of thing, and the access facts say so.
  assert.equal(host.accessMethod, 'lubko-transport');
  assert.equal(host.persistence, 'durable-host-filesystem');
  assert.equal(host.garbageCollection, 'host-local-collector');
  assert.equal(runner.accessMethod, 'github-workflow-dispatch');
  assert.equal(runner.persistence, 'per-job-workspace');
  assert.equal(runner.garbageCollection, 'provider-managed');
  assert.deepEqual(host.guidance, [EXECUTION_TARGET_GUIDANCE.lubko]);
  assert.deepEqual(runner.guidance, [EXECUTION_TARGET_GUIDANCE['github-actions']]);
  // A name is display metadata and falls back to the identity, never the reverse.
  assert.equal(host.displayName, 'phoebe-dev');
});

test('a target names its own access method, persistence, cleanup, and guidance when it has them', () => {
  const access = executionTargetAccess(persistentTarget({
    displayName: 'Phoebe (Lubko)',
    accessMethod: 'lubko-transport',
    persistence: 'durable-host-filesystem',
    garbageCollection: 'none',
    limitations: ['no managed collection roots are configured on this host'],
    guidance: ['docs/skills/resources.md', 'docs/skills/target-lubko-persistent-host.md'],
  }));
  assert.equal(access.displayName, 'Phoebe (Lubko)');
  assert.equal(access.garbageCollection, 'none', 'a host may narrow its own cleanup to nothing');
  assert.deepEqual(access.guidance, ['docs/skills/resources.md', 'docs/skills/target-lubko-persistent-host.md']);
  assert.deepEqual(access.limitations, ['no managed collection roots are configured on this host']);
});

test('the descriptive defaults are the only ones a backend and a kind can have', () => {
  assert.equal(defaultExecutionTargetAccessMethod('lubko'), 'lubko-transport');
  assert.equal(defaultExecutionTargetAccessMethod('github-actions'), 'github-workflow-dispatch');
  assert.equal(defaultExecutionTargetPersistence('persistent-host'), 'durable-host-filesystem');
  assert.equal(defaultExecutionTargetPersistence('ephemeral-environment'), 'per-job-workspace');
  for (const target of [persistentTarget(), ephemeralTarget()]) {
    assert.equal(executionTargetDefect(target), null);
  }
});

test('a target may not state an access method or persistence its backend and kind do not have', () => {
  assert.match(
    executionTargetDefect(persistentTarget({ accessMethod: 'github-workflow-dispatch' })),
    /access method its backend provides/,
  );
  assert.match(
    executionTargetDefect(ephemeralTarget({ persistence: 'durable-host-filesystem' })),
    /persistence its kind has/,
  );
  assert.match(
    executionTargetDefect(persistentTarget({ accessMethod: 'ssh' })),
    /must declare a known access method/,
  );
});

test('a target may narrow its cleanup but never widen it into the other side of the world', () => {
  // A host may say nothing removes its paths; it may not claim the provider does.
  assert.equal(executionTargetDefect(persistentTarget({ garbageCollection: 'none' })), null);
  assert.equal(executionTargetDefect(ephemeralTarget({ garbageCollection: 'none' })), null);
  assert.equal(executionTargetDefect(ephemeralTarget({ garbageCollection: 'provider-managed' })), null);
  assert.match(
    executionTargetDefect(persistentTarget({ garbageCollection: 'provider-managed' })),
    /persistent host cannot declare/,
  );
  assert.match(
    executionTargetDefect(ephemeralTarget({ garbageCollection: 'host-local-collector' })),
    /ephemeral environment cannot declare/,
  );
  assert.match(
    executionTargetDefect(persistentTarget({ garbageCollection: 'vacuum' })),
    /must declare a known garbage collection/,
  );
});

test('caveats are ordered and unique, and guidance is a repository document path', () => {
  assert.match(
    executionTargetDefect(persistentTarget({ limitations: ['b caveat', 'a caveat'] })),
    /limitations must be a sorted/,
  );
  assert.match(
    executionTargetDefect(persistentTarget({ limitations: ['same', 'same'] })),
    /limitations must be a sorted/,
  );
  assert.match(
    executionTargetDefect(persistentTarget({ guidance: ['docs/skills/b.md', 'docs/skills/a.md'] })),
    /guidance must be a sorted/,
  );
  assert.match(
    executionTargetDefect(persistentTarget({ guidance: ['/etc/passwd.md'] })),
    /guidance path is unusable: absolute/,
  );
  assert.match(
    executionTargetDefect(persistentTarget({ guidance: ['../../secrets.md'] })),
    /guidance path is unusable: parent-traversal/,
  );
  assert.match(
    executionTargetDefect(persistentTarget({ guidance: ['https://example.com/run.md'] })),
    /guidance path is unusable: not-a-repository-path/,
  );
  assert.equal(guidancePathDefect('docs/skills/target-lubko-persistent-host.md'), null);
});

test('a board written before the descriptive fields existed still parses', () => {
  // Additive means additive: the record shape already signed into existing logs
  // has to keep verifying, or every board on disk would need rewriting to be
  // readable at all.
  const legacy = boardWith([persistentTarget()]).targets[0];
  assert.equal(legacy.displayName, undefined);
  assert.equal(legacy.guidance, undefined);
  const enriched = boardWith([persistentTarget({
    displayName: 'Phoebe',
    garbageCollection: 'none',
    limitations: ['no managed collection roots are configured'],
    guidance: ['docs/skills/target-lubko-persistent-host.md'],
  })]).targets[0];
  assert.equal(enriched.displayName, 'Phoebe');
  assert.equal(enriched.garbageCollection, 'none');
});

test('an unknown key on a target record is still refused', () => {
  // Tolerating the six optional keys is not the same as tolerating anything.
  assert.throws(() => boardWith([{ ...persistentTarget(), labels: ['x'] }]), /execution target/);
});

test('the API registers, inspects, and corrects a target’s descriptive metadata', async () => {
  const board = api(fakeSkrynia());
  await board.initialize();

  const registered = await board.registerTarget({
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['persistent-filesystem'],
    address: 'lubko://phoebe-dev',
    displayName: 'Phoebe (Lubko)',
    garbageCollection: 'none',
    limitations: ['no managed collection roots are configured on this host'],
    guidance: ['docs/skills/target-lubko-persistent-host.md'],
  });
  assert.equal(registered.displayName, 'Phoebe (Lubko)');
  assert.equal(registered.garbageCollection, 'none');

  // Reading it back through the same API a scheduler uses gives the same access
  // facts, so a dispatcher and a board view cannot disagree about a target.
  const views = await board.listTargets();
  assert.equal(executionTargetAccess(views[0]).garbageCollection, 'none');
  assert.deepEqual(executionTargetAccess(views[0]).guidance, ['docs/skills/target-lubko-persistent-host.md']);

  // Correcting a status must not silently drop what the target says about itself.
  const retired = await board.setTarget('phoebe-dev', {
    status: 'unavailable',
    capabilities: registered.capabilities,
    description: registered.description,
  });
  assert.equal(retired.displayName, 'Phoebe (Lubko)');
  assert.deepEqual(retired.limitations, ['no managed collection roots are configured on this host']);
  assert.deepEqual(retired.guidance, ['docs/skills/target-lubko-persistent-host.md']);

  const corrected = await board.setTarget('phoebe-dev', {
    status: 'unavailable',
    capabilities: registered.capabilities,
    description: registered.description,
    displayName: 'Phoebe (spare)',
    guidance: ['docs/skills/resources.md'],
  });
  assert.equal(corrected.displayName, 'Phoebe (spare)');
  assert.deepEqual(corrected.guidance, ['docs/skills/resources.md']);
});

test('the API refuses descriptive metadata that contradicts the target it registers', async () => {
  const board = api(fakeSkrynia());
  await board.initialize();
  await assert.rejects(() => board.registerTarget({
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['persistent-filesystem'],
    address: 'lubko://phoebe-dev',
    garbageCollection: 'provider-managed',
  }), /persistent host cannot declare/);
  // A refused registration writes nothing, so the catalog holds no half-record.
  const written = await board.loadBoard();
  assert.deepEqual(written.targets, []);
});

test('executionTargetAccess hands back copies of the arrays it read', () => {
  const target = persistentTarget();
  const access = executionTargetAccess(target);
  access.capabilities.push('accelerated-compute');
  access.guidance.push('docs/skills/other.md');
  // The record the caller handed in is untouched: a view that shared its arrays
  // would let one reader's edit become another reader's fact.
  assert.deepEqual(target.capabilities, ['network-egress', 'persistent-filesystem']);
  assert.equal(target.guidance, undefined);
  assert.deepEqual(executionTargetAccess(target).guidance, [EXECUTION_TARGET_GUIDANCE.lubko]);
});

test('the API canonicalizes a note list before anything is signed', async () => {
  const board = api(fakeSkrynia());
  await board.initialize();

  // A blank note is refused here rather than reaching the model as a record the
  // model itself would reject: that rejection would arrive only after the
  // operation had been signed, as a log-verification error the caller never
  // gets to act on.
  await assert.rejects(() => board.registerTarget({
    id: 'phoebe-dev', backend: 'lubko', kind: 'persistent-host',
    capabilities: ['persistent-filesystem'], address: 'lubko://phoebe-dev',
    limitations: ['   '],
  }), /cannot be blank/);
  await assert.rejects(() => board.registerTarget({
    id: 'phoebe-dev', backend: 'lubko', kind: 'persistent-host',
    capabilities: ['persistent-filesystem'], address: 'lubko://phoebe-dev',
    displayName: '   ',
  }), /display name cannot be blank/);
  assert.deepEqual((await board.loadBoard()).targets, [], 'a refused registration writes nothing');

  // An unordered and repeated list is not an error; it is the one spelling the
  // board stores, so two callers that write the same caveats sign the same bytes.
  // The model refuses a duplicate outright, so the API is where it is resolved.
  const registered = await board.registerTarget({
    id: 'phoebe-dev', backend: 'lubko', kind: 'persistent-host',
    capabilities: ['persistent-filesystem'], address: 'lubko://phoebe-dev',
    displayName: '  Phoebe  ',
    limitations: ['second caveat', 'first caveat', 'second caveat'],
    guidance: ['docs/skills/target-lubko-persistent-host.md'],
  });
  assert.equal(registered.displayName, 'Phoebe');
  assert.deepEqual(registered.limitations, ['first caveat', 'second caveat']);
});
