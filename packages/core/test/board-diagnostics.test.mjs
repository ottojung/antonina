import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoardIncompatibilityError,
  executionTargetDefect,
  isBoardIncompatibilityError,
  parseBoard,
  parseLegacyBoardV2,
  parsePersistedBoard,
  upgradePersistedBoard,
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

const message = (id, createdAt = timestamp) => ({ id, author: 'a', body: 'b', createdAt });

const resource = (overrides = {}) => ({
  host: 'lubko://server',
  path: '/workspace/project',
  issueNumbers: [1],
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

const target = (overrides = {}) => ({
  id: 'phoebe-dev',
  backend: 'lubko',
  kind: 'persistent-host',
  status: 'available',
  capabilities: ['persistent-filesystem'],
  address: 'lubko://phoebe',
  description: '',
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

const dispatch = (overrides = {}) => ({
  issueNumber: 1,
  targetId: 'phoebe-dev',
  rationale: 'least surplus',
  recordedAt: timestamp,
  ...overrides,
});

const board = (overrides = {}) => ({
  schemaVersion: 3,
  nextIssueNumber: 2,
  issues: [issue(1)],
  resources: [resource()],
  targets: [target()],
  dispatches: [dispatch()],
  ...overrides,
});

const legacyBoard = (overrides = {}) => ({
  schemaVersion: 2,
  nextIssueNumber: 2,
  issues: [issue(1)],
  resources: [resource()],
  ...overrides,
});

/** The refusal as data, asserting the error type so a plain `Error` cannot pass. */
function refusal(read) {
  try {
    read();
  } catch (error) {
    assert.ok(error instanceof BoardIncompatibilityError,
      `expected a BoardIncompatibilityError, got ${error?.constructor?.name}: ${error?.message}`);
    return error;
  }
  assert.fail('expected the board to be refused');
}

/**
 * The base commit's acceptance semantics, transcribed. This is the property
 * issue 71 must not trade away: a diagnostic may change which words an operator
 * reads, never which boards are accepted. The transcription covers the top-level
 * guard and every post-guard refusal the corpus can reach, and the test below
 * compares it against the reader on each input.
 */
const baseRejectsCanonical = (value) => {
  if (!baseTopLevelAccepts(value)) return true;
  const numbers = new Set();
  for (const entry of value.issues) {
    if (numbers.has(entry.number)) return true;
    numbers.add(entry.number);
    for (let index = 1; index < entry.messages.length; index += 1) {
      if (Date.parse(entry.messages[index - 1].createdAt) > Date.parse(entry.messages[index].createdAt)) return true;
    }
  }
  if (value.nextIssueNumber <= Math.max(0, ...numbers)) return true;
  const resources = new Set();
  for (const resource of value.resources) {
    // The base reader dereferenced `host` before running its own predicate and
    // so raised a TypeError on a non-record element: a refusal, in effect.
    if (!isObject(resource)) return true;
    const key = JSON.stringify([resource.host, resource.path]);
    if (resources.has(key)) return true;
    resources.add(key);
    if (!baseResourceAccepts(resource, numbers)) return true;
  }
  const targetIds = new Set();
  const targetAddresses = new Set();
  for (const target of value.targets) {
    if (!baseTargetAccepts(target)) return true;
    if (targetIds.has(target.id)) return true;
    targetIds.add(target.id);
    if (target.address !== null) {
      if (targetAddresses.has(target.address)) return true;
      targetAddresses.add(target.address);
    }
  }
  const dispatched = new Set();
  for (const dispatch of value.dispatches) {
    if (!baseDispatchAccepts(dispatch, numbers)) return true;
    if (!targetIds.has(dispatch.targetId)) return true;
    if (dispatched.has(dispatch.issueNumber)) return true;
    dispatched.add(dispatch.issueNumber);
  }
  return false;
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value, keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value) => typeof value === 'string' && value.length > 0;
const stamp = (value) => text(value) && Number.isFinite(Date.parse(value));
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const slug = (value) => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
const lubkoHost = (value) => typeof value === 'string' && /^lubko:\/\/[^/\s?#\\]+$/.test(value);
const canonicalPath = (value) => typeof value === 'string'
  && (value === '/' || (value.startsWith('/') && !value.endsWith('/') && !value.includes('//')
    && !value.split('/').some((segment) => segment === '..' || segment === '.')));

const baseMessageAccepts = (value) => isObject(value) && exactKeys(value, ['id', 'author', 'body', 'createdAt'])
  && text(value.id) && text(value.author) && text(value.body) && stamp(value.createdAt);

const baseIssueAccepts = (value) => isObject(value)
  && exactKeys(value, ['number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'messages'])
  && positive(value.number) && text(value.title) && typeof value.body === 'string'
  && (value.state === 'open' || value.state === 'closed')
  && stamp(value.createdAt) && stamp(value.updatedAt)
  && Array.isArray(value.messages) && value.messages.every(baseMessageAccepts);

const baseResourceAccepts = (value, numbers) => isObject(value)
  && exactKeys(value, ['host', 'path', 'issueNumbers', 'createdAt', 'updatedAt'])
  && text(value.host) && lubkoHost(value.host) && text(value.path) && canonicalPath(value.path)
  && Array.isArray(value.issueNumbers) && value.issueNumbers.length > 0
  && value.issueNumbers.every((entry) => positive(entry) && numbers.has(entry))
  && value.issueNumbers.every((entry, index, all) => index === 0 || entry > all[index - 1])
  && stamp(value.createdAt) && stamp(value.updatedAt);

const TARGET_KEYS = ['id', 'backend', 'kind', 'status', 'capabilities', 'address', 'description', 'createdAt', 'updatedAt'];
const TARGET_OPTIONAL_KEYS = ['displayName', 'accessMethod', 'persistence', 'garbageCollection', 'limitations', 'guidance'];

const baseTargetAccepts = (value) => {
  if (!isObject(value)) return false;
  if (!TARGET_KEYS.every((key) => Object.hasOwn(value, key))) return false;
  if (!Object.keys(value).every((key) => TARGET_KEYS.includes(key) || TARGET_OPTIONAL_KEYS.includes(key))) return false;
  if (!text(value.id) || !slug(value.id)) return false;
  if (!['lubko', 'github-actions'].includes(value.backend)) return false;
  if (!['persistent-host', 'ephemeral-environment'].includes(value.kind)) return false;
  if (!text(value.status) || !['available', 'unavailable'].includes(value.status)) return false;
  if (value.address !== null && (!text(value.address) || !lubkoHost(value.address))) return false;
  if (typeof value.description !== 'string') return false;
  if (!stamp(value.createdAt) || !stamp(value.updatedAt)) return false;
  if (value.accessMethod !== undefined && !['transport', 'local-process'].includes(value.accessMethod)) return false;
  if (value.persistence !== undefined && !['host-local', 'provider-managed'].includes(value.persistence)) return false;
  if (value.garbageCollection !== undefined
      && !['host-local-collector', 'provider-managed'].includes(value.garbageCollection)) return false;
  const capabilities = ['persistent-filesystem', 'ephemeral-lifetime', 'network-egress', 'container-isolation', 'accelerated-compute'];
  if (!Array.isArray(value.capabilities)
      || !value.capabilities.every((entry) => typeof entry === 'string' && capabilities.includes(entry))) return false;
  if (value.capabilities.some((entry, index) => index > 0 && value.capabilities[index - 1] > entry)) return false;
  if (new Set(value.capabilities).size !== value.capabilities.length) return false;
  // `executionTargetDefect` runs last at the base commit too and is unchanged
  // by this work, so the transcription calls it rather than restating it.
  return executionTargetDefect(value) === null;
};

const baseDispatchAccepts = (value, numbers) => isObject(value)
  && exactKeys(value, ['issueNumber', 'targetId', 'rationale', 'recordedAt'])
  && positive(value.issueNumber) && numbers.has(value.issueNumber)
  && text(value.targetId) && slug(value.targetId)
  && text(value.rationale) && stamp(value.recordedAt);

const baseTopLevelAccepts = (value) => isObject(value)
  && exactKeys(value, ['schemaVersion', 'nextIssueNumber', 'issues', 'resources', 'targets', 'dispatches'])
  && value.schemaVersion === 3
  && positive(value.nextIssueNumber)
  && Array.isArray(value.issues) && value.issues.every(baseIssueAccepts)
  && Array.isArray(value.resources)
  && Array.isArray(value.targets)
  && Array.isArray(value.dispatches);

test('a schemaVersion from another build is named, not merged into a shape complaint', () => {
  const v2 = refusal(() => parseBoard(legacyBoard()));
  assert.equal(v2.defect.kind, 'schema-version-mismatch');
  assert.equal(v2.defect.found, '2');
  assert.equal(v2.defect.expected, '3');
  assert.match(v2.message, /schema version is 2, but this build reads schema version 3/);
  // The key set of a v2 board is wrong only because of its version, so the
  // diagnostic must not send the operator looking for `targets` and
  // `dispatches` as though they were accidentally dropped.
  assert.doesNotMatch(v2.message, /targets/);
  assert.doesNotMatch(v2.message, /dispatches/);

  const future = refusal(() => parseBoard(board({ schemaVersion: 4 })));
  assert.equal(future.defect.kind, 'schema-version-mismatch');
  assert.equal(future.defect.found, '4');
  assert.match(future.message, /schema version is 4/);

  const absent = refusal(() => parseBoard({ ...board(), schemaVersion: undefined }));
  assert.equal(absent.defect.found, 'a value that is not a schema version');

  // The v2 shape still parses as the legacy board, and still upgrades.
  assert.equal(parsePersistedBoard(legacyBoard()).schemaVersion, 2);
  assert.equal(upgradePersistedBoard(legacyBoard()).schemaVersion, 3);
});

test('a wrong shape is reported as a shape, naming the missing and extra keys', () => {
  const extra = refusal(() => parseBoard({ ...board(), extra: true }));
  assert.equal(extra.defect.kind, 'key-set');
  assert.deepEqual(extra.defect.unexpectedKeys, ['extra']);
  assert.match(extra.message, /wrong keys \(unexpected 'extra'\)/);

  const missing = refusal(() => {
    const value = board();
    delete value.targets;
    return parseBoard(value);
  });
  assert.equal(missing.defect.kind, 'key-set');
  assert.deepEqual(missing.defect.missingKeys, ['targets']);
  assert.deepEqual(missing.defect.unexpectedKeys, []);
  assert.match(missing.message, /missing targets/);

  for (const value of [null, undefined, 7, 'board', [], true]) {
    const error = refusal(() => parseBoard(value));
    assert.equal(error.defect.kind, 'not-a-record', `for ${String(value)}`);
    assert.match(error.message, /is not a JSON object/);
  }
});

test('a malformed top-level field names the field', () => {
  const counter = refusal(() => parseBoard(board({ nextIssueNumber: '2' })));
  assert.equal(counter.defect.field, 'nextIssueNumber');
  assert.equal(counter.defect.found, 'a string');
  assert.match(counter.message, /malformed field nextIssueNumber: found a string, expected a positive safe integer/);

  for (const field of ['issues', 'resources', 'targets', 'dispatches']) {
    const error = refusal(() => parseBoard(board({ [field]: {} })));
    assert.equal(error.defect.field, field, field);
    assert.equal(error.defect.found, 'an object');
    assert.match(error.message, new RegExp(`malformed field ${field}: found an object, expected an array`));
  }
});

test('a malformed nested record names the index and the field', () => {
  const issueNumber = refusal(() => parseBoard(board({ issues: [issue(1), { ...issue(2), number: 0 }] })));
  assert.equal(issueNumber.defect.kind, 'element');
  assert.equal(issueNumber.defect.subject, 'board issue at index 1');
  assert.equal(issueNumber.defect.field, 'number');
  assert.equal(issueNumber.defect.found, 'a number');
  assert.match(issueNumber.message, /board issue at index 1 has a malformed field number/);

  const extraKey = refusal(() => parseBoard(board({ issues: [{ ...issue(1), assignee: 'agent' }] })));
  assert.equal(extraKey.defect.subject, 'board issue at index 0');
  assert.deepEqual(extraKey.defect.unexpectedKeys, ['assignee']);

  const badMessage = refusal(() => parseBoard(board({
    issues: [{ ...issue(1), messages: [message('one'), { ...message('two'), body: 7 }] }],
  })));
  assert.equal(badMessage.defect.subject, 'board issue 1 message at index 1');
  assert.equal(badMessage.defect.field, 'body');

  const badResource = refusal(() => parseBoard(board({ resources: [resource(), { ...resource(), path: 'relative' }] })));
  assert.equal(badResource.defect.subject, 'board resource at index 1');
  assert.equal(badResource.defect.field, 'path');

  const dangling = refusal(() => parseBoard(board({ resources: [resource({ issueNumbers: [9] })] })));
  assert.equal(dangling.defect.subject, 'board resource at index 0');
  assert.equal(dangling.defect.field, 'issueNumbers index 0');
  assert.match(dangling.message, /expected an issue number that exists on this board/);

  const emptyNumbers = refusal(() => parseBoard(board({ resources: [resource({ issueNumbers: [] })] })));
  assert.match(emptyNumbers.message, /an array of 0 entries, expected at least one issue number/);

  const badTarget = refusal(() => parseBoard(board({ targets: [{ ...target(), backend: 'ssh' }] })));
  assert.equal(badTarget.defect.subject, 'board execution target at index 0');
  assert.equal(badTarget.defect.field, 'backend');
  assert.match(badTarget.message, /expected one of lubko, github-actions/);

  const targetKey = refusal(() => parseBoard(board({ targets: [{ ...target(), labels: ['x'] }] })));
  assert.deepEqual(targetKey.defect.unexpectedKeys, ['labels']);

  const badDispatch = refusal(() => parseBoard(board({ dispatches: [dispatch({ issueNumber: 2 })] })));
  assert.equal(badDispatch.defect.subject, 'board dispatch record at index 0');
  assert.equal(badDispatch.defect.field, 'issueNumber');
});

test('data that is corrupt rather than mismatched is its own kind', () => {
  const counter = refusal(() => parseBoard(board({ nextIssueNumber: 1 })));
  assert.equal(counter.defect.kind, 'corrupt');
  assert.notEqual(counter.defect.kind, 'schema-version-mismatch');

  const duplicateIssue = refusal(() => parseBoard(board({ issues: [issue(1), issue(1)], nextIssueNumber: 3 })));
  assert.equal(duplicateIssue.defect.kind, 'corrupt');

  const duplicateResource = refusal(() => parseBoard(board({ resources: [resource(), resource()] })));
  assert.equal(duplicateResource.defect.kind, 'corrupt');
  assert.match(duplicateResource.message, /duplicate resources/);

  const duplicateTarget = refusal(() => parseBoard(board({ targets: [target(), target()] })));
  assert.equal(duplicateTarget.defect.kind, 'corrupt');
  assert.match(duplicateTarget.message, /duplicate execution target identities/);

  const outOfOrder = refusal(() => parseBoard(board({
    issues: [{
      ...issue(1),
      messages: [message('later', '2026-09-24T00:01:00.000Z'), message('earlier')],
    }],
  })));
  assert.equal(outOfOrder.defect.kind, 'corrupt');
  assert.match(outOfOrder.message, /out of chronological order/);

  const unregistered = refusal(() => parseBoard(board({ dispatches: [dispatch({ targetId: 'other-target' })] })));
  assert.equal(unregistered.defect.kind, 'corrupt');
  assert.match(unregistered.message, /unregistered execution target/);

  const duplicatedDispatch = refusal(() => parseBoard(board({ dispatches: [dispatch(), dispatch()] })));
  assert.equal(duplicatedDispatch.defect.kind, 'corrupt');
});

test('the legacy reader reports the same way', () => {
  const counter = refusal(() => parseLegacyBoardV2(legacyBoard({ nextIssueNumber: '2' })));
  assert.equal(counter.defect.field, 'nextIssueNumber');

  const extra = refusal(() => parseLegacyBoardV2({ ...legacyBoard(), targets: [] }));
  assert.equal(extra.defect.kind, 'key-set');
  assert.deepEqual(extra.defect.unexpectedKeys, ['targets']);

  const dangling = refusal(() => parseLegacyBoardV2(legacyBoard({ resources: [resource({ issueNumbers: [9] })] })));
  assert.equal(dangling.defect.kind, 'element');
  assert.equal(dangling.defect.field, 'issueNumbers index 0');
});

/**
 * The acceptance property itself. Every input in the corpus below is either one
 * the base commit accepted or one it refused, and the reader must agree with
 * that on every one of them: the diagnostics may name the reason, but nothing
 * here is admitted that was refused and nothing is dropped that was accepted.
 */
test('acceptance is unchanged from the base reader on a corpus of malformed boards', () => {
  const corpus = [
    board(),
    board({ nextIssueNumber: 3 }),
    board({ schemaVersion: 2 }),
    board({ schemaVersion: 4 }),
    board({ schemaVersion: '3' }),
    board({ schemaVersion: null }),
    board({ schemaVersion: Number.MAX_SAFE_INTEGER + 1 }),
    board({ nextIssueNumber: 0 }),
    board({ nextIssueNumber: -1 }),
    board({ nextIssueNumber: 1.5 }),
    board({ nextIssueNumber: '1' }),
    board({ nextIssueNumber: undefined }),
    board({ issues: [] }),
    board({ issues: {} }),
    board({ issues: [null] }),
    board({ issues: [[]] }),
    board({ issues: ['issue'] }),
    board({ issues: [{ ...issue(1), assignee: 'agent' }] }),
    board({ issues: [{ ...issue(1), number: '1' }] }),
    board({ issues: [{ ...issue(1), number: 0 }] }),
    board({ issues: [{ ...issue(1), title: '' }] }),
    board({ issues: [{ ...issue(1), body: 7 }] }),
    board({ issues: [{ ...issue(1), state: 'open ' }] }),
    board({ issues: [{ ...issue(1), createdAt: 'yesterday' }] }),
    board({ issues: [{ ...issue(1), messages: {} }] }),
    board({ issues: [{ ...issue(1), messages: [message('one', '2026-09-24T00:01:00.000Z'), message('two')] }] }),
    board({ issues: [{ ...issue(1), messages: [message('one'), { ...message('two'), author: '' }] }] }),
    board({ issues: [{ ...issue(1), messages: [message('one'), { ...message('two'), createdAt: 'soon' }] }] }),
    board({ issues: [{ ...issue(1), messages: [message('one'), { ...message('two'), secret: 'x' }] }] }),
    board({ issues: [issue(1), issue(1)] }),
    board({ issues: [issue(1), issue(2)], nextIssueNumber: 2 }),
    board({ resources: [] }),
    board({ resources: {} }),
    board({ resources: [null] }),
    board({ resources: [resource(), resource()] }),
    board({ resources: [resource({ issueNumbers: [] })] }),
    board({ resources: [resource({ issueNumbers: [1, 1] })] }),
    board({ resources: [resource({ issueNumbers: [2, 1] })] }),
    board({ resources: [resource({ issueNumbers: [9] })] }),
    board({ resources: [resource({ issueNumbers: ['1'] })] }),
    board({ resources: [resource({ host: 'https://server' })] }),
    board({ resources: [resource({ path: '/a/../b' })] }),
    board({ resources: [resource({ createdAt: 'soon' })] }),
    board({ targets: [] }),
    board({ targets: {} }),
    board({ targets: [null] }),
    board({ targets: [target(), target()] }),
    board({ targets: [target({ id: 'Phoebe' })] }),
    board({ targets: [target({ backend: 'ssh' })] }),
    board({ targets: [target({ kind: 'cloud' })] }),
    board({ targets: [target({ status: 'busy' })] }),
    board({ targets: [target({ address: 'https://phoebe' })] }),
    board({ targets: [target({ description: 7 })] }),
    board({ targets: [target({ capabilities: [] })] }),
    board({ targets: [target({ capabilities: ['persistent-filesystem', 'network-egress'].reverse() })] }),
    board({ targets: [target({ capabilities: ['network-egress', 'network-egress'] })] }),
    board({ targets: [target({ capabilities: ['teleport'] })] }),
    board({ targets: [target({ createdAt: 'soon' })] }),
    board({ targets: [{ ...target(), displayName: 7 }] }),
    board({ targets: [{ ...target(), accessMethod: 'ssh' }] }),
    board({ targets: [{ ...target(), persistence: 'disk' }] }),
    board({ targets: [{ ...target(), garbageCollection: 'never' }] }),
    board({ targets: [{ ...target(), limitations: ['a', 'a'] }] }),
    board({ targets: [{ ...target(), guidance: ['/abs.md'] }] }),
    board({ targets: [target({ address: null })] }),
    board({ dispatches: [] }),
    board({ dispatches: {} }),
    board({ dispatches: [null] }),
    board({ dispatches: [dispatch(), dispatch()] }),
    board({ dispatches: [dispatch({ issueNumber: 9 })] }),
    board({ dispatches: [dispatch({ issueNumber: 0 })] }),
    board({ dispatches: [dispatch({ targetId: 'Other' })] }),
    board({ dispatches: [dispatch({ targetId: 'absent-target' })] }),
    board({ dispatches: [dispatch({ rationale: '' })] }),
    board({ dispatches: [dispatch({ recordedAt: 'soon' })] }),
    board({ dispatches: [{ ...dispatch(), extra: 1 }] }),
    board({ extra: true }),
    { ...board(), targets: undefined },
    { nextIssueNumber: 2, issues: [], resources: [], targets: [], dispatches: [] },
    null,
    undefined,
    0,
    '',
    'board',
    [],
    [board()],
    true,
  ];

  let accepted = 0;
  let refused = 0;
  for (const value of corpus) {
    const baseAccepts = !baseRejectsCanonical(value);
    let threw = false;
    try {
      parseBoard(value);
    } catch (error) {
      threw = true;
      assert.ok(error instanceof BoardIncompatibilityError,
        `a refused board must report a BoardIncompatibilityError, got ${error?.message}`);
      assert.ok(error.defect.kind.length > 0, 'every refusal carries a kind');
      assert.ok(error.message.length > 0, 'every refusal carries a message');
    }
    assert.equal(threw, !baseAccepts,
      `acceptance diverged from the base reader for ${JSON.stringify(value)}`);
    if (threw) refused += 1;
    else accepted += 1;
  }
  // The corpus is only worth anything if it actually contains both outcomes.
  assert.ok(accepted > 0, 'the corpus must contain a board the reader accepts');
  assert.ok(refused > 20, `the corpus must contain many refusals, saw ${refused}`);
});

/**
 * A diagnostic describes a field; it never reproduces a value. A board that
 * carries a credential in the wrong place must be refused and must not put that
 * credential in the message an operator, a log or a browser sees.
 */
test('no diagnostic reproduces a value from the board it refuses', () => {
  const credential = 'antonina.eyJraWQiOiJyb290In0.super-secret-signature';
  // Only refused inputs are listed. A field that legitimately holds arbitrary
  // text — an issue title, a message body — accepts a credential-shaped string,
  // and that is the base reader's behaviour too; a diagnostic never sees such a
  // board, so there is nothing to keep out of the message. The last assertion
  // below pins that limit down rather than leaving it implied.
  const cases = [
    [board({ nextIssueNumber: credential }), 'nextIssueNumber'],
    [board({ resources: [resource({ issueNumbers: [credential] })] }), 'issueNumbers'],
    [board({ targets: [target({ id: credential })] }), 'id'],
    [board({ targets: [target({ capabilities: [credential] })] }), 'capabilities'],
    [board({ schemaVersion: credential }), 'schemaVersion'],
    [{ ...board(), [credential]: 1 }, 'a key that is a credential'],
    [{ ...board(), extra: credential }, 'an unexpected key that is a credential'],
    [{ ...board(), ['a'.repeat(200)]: 1 }, 'an over-long unexpected key'],
  ];
  for (const [value, where] of cases) {
    const error = refusal(() => parseBoard(value));
    assert.doesNotMatch(error.message, /secret|antonina\./, `the message must not carry the payload (${where})`);
    assert.ok(!error.message.includes(credential.split('.')[1]),
      `the message must not carry a credential fragment (${where})`);
    assert.doesNotMatch(JSON.stringify(error.defect.found), /secret/,
      `the found value must be described, not quoted (${where})`);
  }
  // A credential that is a *legitimate* shape is quoted only where a bounded
  // echo is deliberate and the value is not secret-bearing: an unexpected key
  // name is bounded, and a key that cannot be one is described instead.
  const bounded = refusal(() => parseBoard({ ...board(), ['a'.repeat(200)]: 1 }));
  assert.match(bounded.message, /a key name that is not a plain identifier/);
  const shapeVersion = refusal(() => parseBoard(board({ schemaVersion: credential })));
  assert.match(shapeVersion.message, /a value that is not a schema version/);
  // The limit of the guarantee, stated rather than implied: a field that is
  // *supposed* to hold free text accepts a credential-shaped string, and the
  // board is then simply a valid board. The reader is not a secret scanner.
  assert.doesNotThrow(() => parseBoard(board({ issues: [{ ...issue(1), title: credential }] })));
});

test('the error is recognisable without reading the message', () => {
  const error = refusal(() => parseBoard(board({ nextIssueNumber: 0 })));
  assert.equal(isBoardIncompatibilityError(error), true);
  assert.equal(isBoardIncompatibilityError(new Error('same words')), false);
  assert.equal(isBoardIncompatibilityError(null), false);
  assert.equal(error.name, 'BoardIncompatibilityError');
  assert.ok(error instanceof Error);
});
