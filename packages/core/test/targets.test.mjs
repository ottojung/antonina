import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoardApi,
  TargetSelectionError,
} from '../dist/api.js';
import {
  canonicalTargetRequirements,
  executionTargetDefect,
  parseBoard,
  resourceViews,
  selectExecutionTarget,
  targetViews,
} from '../dist/model.js';

const timestamp = '2026-09-24T00:00:00.000Z';

const issue = (number, state = 'open') => ({
  number,
  title: `Issue ${number}`,
  body: '',
  state,
  createdAt: timestamp,
  updatedAt: timestamp,
  messages: [],
});

const persistentTarget = (overrides = {}) => ({
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
});

const ephemeralTarget = (overrides = {}) => ({
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
});

const resource = (overrides = {}) => ({
  host: 'lubko://phoebe-dev',
  path: '/workspace/project-worktree',
  issueNumbers: [1],
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

function boardWith(targets, resources = [], dispatches = []) {
  return parseBoard({
    schemaVersion: 3,
    nextIssueNumber: 2,
    issues: [issue(1)],
    resources,
    targets,
    dispatches,
  });
}

test('a target record carries its identity, backend, kind, capabilities, and host address', () => {
  const board = boardWith([ephemeralTarget(), persistentTarget()]);
  assert.deepEqual(board.targets.map((target) => target.id), ['github-actions', 'phoebe-dev']);
  assert.equal(selectExecutionTarget(board).target.id, 'phoebe-dev');
});

test('the canonical board parser refuses the schema that had no execution targets', () => {
  assert.throws(
    () => parseBoard({ schemaVersion: 2, nextIssueNumber: 1, issues: [], resources: [], targets: [], dispatches: [] }),
    /incompatible/,
  );
});

test('execution target records are strict about shape, ordering, and internal consistency', () => {
  const valid = persistentTarget();
  assert.throws(() => boardWith([{ ...valid, labels: ['x'] }]), /execution target/);
  assert.throws(() => boardWith([{ ...valid, id: 'Phoebe' }]), /execution target/);
  assert.throws(() => boardWith([{ ...valid, backend: 'ssh' }]), /execution target/);
  assert.throws(() => boardWith([{ ...valid, status: 'busy' }]), /execution target/);
  // Unsorted and duplicated capabilities are two different defects.
  assert.throws(() => boardWith([{ ...valid, capabilities: ['persistent-filesystem', 'network-egress'] }]), /execution target/);
  assert.throws(() => boardWith([{ ...valid, capabilities: ['persistent-filesystem', 'persistent-filesystem'] }]), /execution target/);
  // A persistent host without a durable filesystem, or with an ephemeral
  // lifetime, describes nothing real and is refused rather than stored.
  assert.throws(() => boardWith([{ ...valid, address: null }]), /execution target/);
  assert.throws(() => boardWith([{ ...valid, capabilities: ['network-egress'] }]), /execution target/);
  assert.throws(() => boardWith([{ ...valid, capabilities: ['ephemeral-lifetime', 'persistent-filesystem'] }]), /execution target/);
  // An ephemeral environment has no host filesystem, so it has no address.
  assert.throws(() => boardWith([ephemeralTarget({ address: 'lubko://runner' })]), /execution target/);
  assert.throws(() => boardWith([ephemeralTarget({ capabilities: ['container-isolation', 'ephemeral-lifetime', 'persistent-filesystem'] })]), /execution target/);
});

test('the github-actions backend runs ephemeral environments only', () => {
  // Every other property of this record is what a well-formed persistent host
  // has -- a Lubko address, a durable filesystem, no ephemeral lifetime, sorted
  // and unique capabilities -- so the backend/kind pairing is the only thing
  // left that can be refusing it.
  const runner = persistentTarget({
    id: 'actions-runner',
    backend: 'github-actions',
    address: 'lubko://actions-runner',
  });
  assert.equal(
    executionTargetDefect(runner),
    'the github-actions backend runs ephemeral environments only',
  );
  // The same record on a backend that can host a persistent machine is sound,
  // so the defect above is the pairing and not the shape of the record.
  assert.equal(executionTargetDefect({ ...runner, backend: 'lubko' }), null);
  assert.throws(() => boardWith([runner]), /execution target/);
});

test('two execution targets may not share one identity or one host address', () => {
  assert.throws(() => boardWith([persistentTarget(), persistentTarget()]), /duplicate execution target identities/);
  assert.throws(
    () => boardWith([persistentTarget(), persistentTarget({ id: 'phoebe-mirror' })]),
    /one Lubko address/,
  );
});

test('a resource is related to the catalogued target whose address is its host', () => {
  const board = boardWith(
    [persistentTarget(), ephemeralTarget()],
    [resource(), resource({ path: '/workspace/other', host: 'lubko://unregistered-host' })],
  );
  assert.deepEqual(
    resourceViews(board).map((view) => [view.path, view.targetId]),
    [['/workspace/project-worktree', 'phoebe-dev'], ['/workspace/other', null]],
  );
  const views = targetViews(board);
  assert.deepEqual(views[0].resources, [], 'an ephemeral target has no durable host filesystem');
  assert.deepEqual(views[1].resources.map((entry) => entry.path), ['/workspace/project-worktree']);
});

test('an ephemeral execution target needs no resource anywhere in the board', () => {
  const board = boardWith([ephemeralTarget(), persistentTarget()], [resource()]);
  assert.equal(board.resources.length, 1);
  const ephemeral = targetViews(board).find((view) => view.id === 'github-actions');
  assert.equal(ephemeral.resources.length, 0);
  assert.equal(ephemeral.address, null);
  assert.equal(selectExecutionTarget(board, { targetId: 'github-actions' }).outcome, 'selected');
});

test('a job may explicitly request a target by identity', () => {
  const board = boardWith([persistentTarget(), ephemeralTarget()]);
  const selection = selectExecutionTarget(board, { targetId: 'phoebe-dev' });
  assert.equal(selection.outcome, 'selected');
  assert.equal(selection.target.id, 'phoebe-dev');
  assert.equal(selection.rule, 'requested-target');
  assert.match(selection.rationale, /requested target phoebe-dev/);
});

test('capability requirements select the target that declares them', () => {
  const board = boardWith([
    persistentTarget(),
    persistentTarget({ id: 'phoebe-gpu', address: 'lubko://phoebe-gpu', capabilities: ['accelerated-compute', 'persistent-filesystem'] }),
    ephemeralTarget(),
  ]);
  const gpu = selectExecutionTarget(board, { capabilities: ['accelerated-compute'] });
  assert.equal(gpu.target.id, 'phoebe-gpu');

  // Every named capability is required, not merely one of them.
  const both = selectExecutionTarget(board, {
    capabilities: ['accelerated-compute', 'persistent-filesystem'],
  });
  assert.equal(both.target.id, 'phoebe-gpu');
  assert.equal(selectExecutionTarget(board, { capabilities: ['accelerated-compute', 'ephemeral-lifetime'] }).outcome, 'no-eligible-target');
  assert.equal(selectExecutionTarget(board, { backend: 'lubko', kind: 'persistent-host' }).target.id, 'phoebe-dev');
  assert.equal(selectExecutionTarget(board, { backend: 'lubko', kind: 'ephemeral-environment' }).outcome, 'no-eligible-target');
});

test('requirements are canonicalized so an unsorted request is still one request', () => {
  const board = boardWith([persistentTarget(), ephemeralTarget()]);
  const first = selectExecutionTarget(board, { capabilities: ['network-egress', 'container-isolation'] });
  const second = selectExecutionTarget(board, { capabilities: ['container-isolation', 'network-egress'] });
  assert.equal(first.target.id, second.target.id);
  assert.deepEqual(first.requirements, canonicalTargetRequirements({ capabilities: ['container-isolation', 'network-egress'] }));
  assert.deepEqual(first.requirements.capabilities, ['container-isolation', 'network-egress']);
});

test('routing is deterministic and breaks ties on the lower target identity', () => {
  const first = persistentTarget({ id: 'alpha', address: 'lubko://alpha', capabilities: ['network-egress', 'persistent-filesystem'] });
  const second = persistentTarget({ id: 'beta', address: 'lubko://beta', capabilities: ['network-egress', 'persistent-filesystem'] });
  const request = { capabilities: ['network-egress'] };
  // Two equally-least-surplus candidates, registered in both orders.
  assert.equal(selectExecutionTarget(boardWith([first, second]), request).target.id, 'alpha');
  assert.equal(selectExecutionTarget(boardWith([second, first]), request).target.id, 'alpha');
  assert.equal(
    selectExecutionTarget(boardWith([first, second]), request).rationale,
    selectExecutionTarget(boardWith([second, first]), request).rationale,
  );

  // The least over-provisioned eligible target wins, which is why a target that
  // declares one undeclared capability loses to one that declares two.
  const minimal = persistentTarget({ id: 'alpha', address: 'lubko://alpha', capabilities: ['network-egress', 'persistent-filesystem'] });
  const loaded = persistentTarget({ id: 'beta', address: 'lubko://beta', capabilities: ['accelerated-compute', 'network-egress', 'persistent-filesystem'] });
  const chosen = selectExecutionTarget(boardWith([loaded, minimal]), request);
  assert.equal(chosen.target.id, 'alpha');
  assert.equal(chosen.rule, 'least-surplus-capabilities');
  assert.match(chosen.rationale, /fewest capabilities the request did not ask for/);
});

test('an ineligible or unavailable target fails by name instead of falling through', () => {
  const board = boardWith([
    persistentTarget(),
    persistentTarget({ id: 'beta', address: 'lubko://beta' }),
    ephemeralTarget({ status: 'unavailable' }),
  ]);
  const unknown = selectExecutionTarget(board, { targetId: 'nowhere' });
  assert.equal(unknown.outcome, 'unknown-target');
  assert.equal(unknown.target, null);
  assert.match(unknown.rationale, /requested target nowhere is not registered/);

  const down = selectExecutionTarget(board, { targetId: 'github-actions' });
  assert.equal(down.outcome, 'unavailable-target');
  assert.match(down.rationale, /registered but unavailable/);

  const wrong = selectExecutionTarget(board, { targetId: 'phoebe-dev', kind: 'ephemeral-environment' });
  assert.equal(wrong.outcome, 'ineligible-target');
  assert.match(wrong.rationale, /kind=ephemeral-environment/);
  assert.equal(wrong.target, null);

  const none = selectExecutionTarget(board, { capabilities: ['accelerated-compute'] });
  assert.equal(none.outcome, 'no-eligible-target');
  assert.match(none.rationale, /no registered available target/);
  assert.equal(selectExecutionTarget(emptyCatalog(), {}).rationale, 'no execution targets are registered');
});

test('every considered target is reported with the requirement that refused it', () => {
  const board = boardWith([persistentTarget(), ephemeralTarget({ status: 'unavailable' })]);
  const selection = selectExecutionTarget(board, { capabilities: ['accelerated-compute'] });
  assert.deepEqual(selection.considered, [
    {
      targetId: 'github-actions',
      backend: 'github-actions',
      kind: 'ephemeral-environment',
      status: 'unavailable',
      eligible: false,
      unmet: ['unavailable', 'capability=accelerated-compute'],
      surplus: ['container-isolation', 'ephemeral-lifetime', 'network-egress'],
    },
    {
      targetId: 'phoebe-dev',
      backend: 'lubko',
      kind: 'persistent-host',
      status: 'available',
      eligible: false,
      unmet: ['capability=accelerated-compute'],
      surplus: ['network-egress', 'persistent-filesystem'],
    },
  ]);
});

test('a dispatch record names a registered target and one record per issue', () => {
  const dispatch = { issueNumber: 1, targetId: 'phoebe-dev', rationale: 'least surplus', recordedAt: timestamp };
  const board = boardWith([persistentTarget()], [], [dispatch]);
  assert.deepEqual(targetViews(board)[0].dispatchedIssues, [1]);
  assert.throws(
    () => boardWith([persistentTarget()], [], [dispatch, { ...dispatch }]),
    /duplicate dispatch records/,
  );
  assert.throws(() => boardWith([ephemeralTarget()], [], [dispatch]), /unregistered execution target/);
  assert.throws(() => boardWith([persistentTarget()], [], [{ ...dispatch, issueNumber: 2 }]), /dispatch record/);
});

function emptyCatalog() {
  return boardWith([]);
}

// --- the signed board surface -------------------------------------------

const STAMP = '2026-09-25T12:00:00.000Z';

function jsonResponse(value, status, etag) {
  const headers = { 'Content-Type': 'application/json' };
  if (etag !== undefined) headers.ETag = etag;
  return new Response(JSON.stringify(value), { status, headers });
}

function fakeSkrynia() {
  const capability = 'a'.repeat(64);
  let signed = null;
  let revision = 0;
  const etag = () => `"v${revision}"`;

  return {
    capability,
    get signed() { return signed; },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      if (!String(url).endsWith('/store/antonina/board-v2')) return new Response(null, { status: 404 });
      if (method === 'GET') {
        return signed === null ? new Response(null, { status: 404 }) : jsonResponse(signed, 200, etag());
      }
      if (method === 'POST') {
        if (signed !== null) return new Response(null, { status: 409 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return jsonResponse({ mode: 'capability-write', capability }, 201);
      }
      if (method === 'PUT') {
        const headers = new Headers(init.headers);
        if (headers.get('X-Skrynia-Capability') !== capability) return jsonResponse({ error: 'invalid capability' }, 403);
        if (headers.get('If-Match') !== etag()) return new Response(null, { status: 412 });
        signed = JSON.parse(String(init.body));
        revision += 1;
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    },
  };
}

function api(server, options = {}) {
  let sequence = 0;
  return new BoardApi({
    fetch: server.fetch.bind(server),
    now: () => new Date(STAMP),
    newId: () => `target-${++sequence}`,
    ...options,
  });
}

test('the API registers, inspects, and reroutes catalogued execution targets', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();

  const phoebe = await client.registerTarget({
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['network-egress', 'persistent-filesystem'],
    address: 'lubko://phoebe-dev',
    description: 'persistent Lubko workstation',
  });
  assert.equal(phoebe.status, 'available');
  const actions = await client.registerTarget({
    id: 'github-actions',
    backend: 'github-actions',
    kind: 'ephemeral-environment',
    capabilities: ['container-isolation', 'ephemeral-lifetime', 'network-egress'],
    address: null,
  });
  assert.equal(actions.address, null);

  const listed = await client.listTargets();
  assert.deepEqual(listed.map((target) => target.id), ['github-actions', 'phoebe-dev']);
  await assert.rejects(() => client.getTarget('nowhere'), /not registered/);

  // An inconsistent record is refused before it is signed at all.
  await assert.rejects(() => client.registerTarget({
    id: 'no-address',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['persistent-filesystem'],
    address: null,
  }), /Lubko address/);
  await assert.rejects(() => client.registerTarget({
    id: 'second-phoebe',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['persistent-filesystem'],
    address: 'lubko://phoebe-dev',
  }), /Lubko address/);

  // Retiring a host is a status change, not a different target, and the
  // catalogued capabilities survive a bare status change.
  const retired = await client.setTarget('phoebe-dev', {
    status: 'unavailable',
    capabilities: phoebe.capabilities,
    description: phoebe.description,
  });
  assert.equal(retired.status, 'unavailable');
  assert.deepEqual(retired.capabilities, phoebe.capabilities);
  const retiredSelection = selectExecutionTarget(await client.loadBoard(), { capabilities: ['persistent-filesystem'] });
  assert.equal(retiredSelection.outcome, 'no-eligible-target');
  await assert.rejects(() => client.selectTarget({ targetId: 'phoebe-dev' }), TargetSelectionError);

  // Only a capable, available target is selectable, and the answer is stable.
  const stable = await client.selectTarget({ capabilities: ['ephemeral-lifetime', 'network-egress'] });
  assert.equal(stable.target.id, 'github-actions');
  assert.equal((await client.selectTarget({ capabilities: ['network-egress', 'ephemeral-lifetime'] })).target.id, 'github-actions');
});

test('a dispatch is recorded on the board with the target that ran and the reason', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('Route me');
  await client.registerTarget({
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['network-egress', 'persistent-filesystem'],
    address: 'lubko://phoebe-dev',
  });
  await client.registerTarget({
    id: 'github-actions',
    backend: 'github-actions',
    kind: 'ephemeral-environment',
    capabilities: ['container-isolation', 'ephemeral-lifetime', 'network-egress'],
    address: null,
  });

  const explicit = await client.recordDispatch(issue.number, { targetId: 'phoebe-dev' });
  assert.equal(explicit.targetId, 'phoebe-dev');
  assert.match(explicit.rationale, /requested target phoebe-dev/);

  const routed = await client.recordDispatch(issue.number, { backend: 'github-actions' });
  assert.equal(routed.targetId, 'github-actions');
  assert.equal((await client.loadBoard()).dispatches.length, 1, 'one record per job replaces the earlier one');
  assert.deepEqual((await client.listTargets())[0].dispatchedIssues, [issue.number]);

  // A closed issue has no job left to dispatch, and an unknown target is not
  // resolved to some other target.
  await assert.rejects(() => client.recordDispatch(9999, {}), /missing issue/);
  await assert.rejects(() => client.recordDispatch(issue.number, { targetId: 'nowhere' }), TargetSelectionError);
  await client.close(issue.number);
  await assert.rejects(() => client.recordDispatch(issue.number, {}), /open issue/);
});

test('deleting a dispatched issue removes the dispatch that named it', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const dispatched = await client.createIssue('Route me');
  const kept = await client.createIssue('Keep me');
  await client.registerTarget({
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['persistent-filesystem'],
    address: 'lubko://phoebe-dev',
  });
  await client.recordDispatch(dispatched.number, { targetId: 'phoebe-dev' });
  await client.recordDispatch(kept.number, { targetId: 'phoebe-dev' });

  // The delete is a normal board operation, not a refusal: a dispatch record
  // naming a number the board no longer holds would leave the board
  // unparseable, so the cascade takes the record with the issue.
  const board = await client.deleteIssue(dispatched.number);
  assert.equal(board.issues.length, 1);
  assert.equal(board.issues[0].number, kept.number);
  assert.deepEqual(board.dispatches.map((entry) => entry.issueNumber), [kept.number]);
  // And the committed board is still a board, read back through the parser.
  assert.deepEqual((await client.loadBoard()).dispatches.map((entry) => entry.issueNumber), [kept.number]);
});

test('a resource registered on a catalogued host is related to that target', async () => {
  const server = fakeSkrynia();
  const client = api(server);
  await client.initialize();
  const issue = await client.createIssue('Work here');
  await client.registerTarget({
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['persistent-filesystem'],
    address: 'lubko://phoebe-dev',
  });
  await client.addResourceDependency('lubko://phoebe-dev', '/workspace/project-worktree', issue.number);
  assert.deepEqual((await client.listResources())[0].targetId, 'phoebe-dev');
  assert.deepEqual((await client.listTargets())[0].resources.map((entry) => entry.path), ['/workspace/project-worktree']);
});

test('target registration and dispatch need the target capability a credential may not hold', async () => {
  const server = fakeSkrynia();
  const root = api(server);
  const initialized = await root.initialize();
  await root.createIssue('Delegated');
  const child = await root.delegateCredential(['issue.create', 'target.read']);
  const reader = api(server, { credential: child, trustAnchor: initialized.trustAnchor });

  await assert.rejects(() => reader.registerTarget({
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    capabilities: ['persistent-filesystem'],
    address: 'lubko://phoebe-dev',
  }), /target.modify/);
  assert.deepEqual(await reader.listTargets(), [], 'reading the catalog needs no write access');
});
