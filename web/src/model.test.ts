import { describe, expect, it } from 'vitest';
import {
  BOARD_SCHEMA_VERSION,
  canonicalHost,
  canonicalPath,
  parseBoard,
  PERSISTED_BOARD_VERSIONS,
  resourceState,
  type Board,
  type BoardIssue,
  type BoardResource,
} from './model';

const timestamp = '2026-09-24T00:00:00.000Z';
// The oldest version this build declares, less one: a version no build in this
// line wrote, so it is refused as too old rather than merely unreadable.
// Derived, not written as `1`, because the readable floor moves at a bump and a
// literal would keep asserting about a version this build no longer knows.
// Taken from the declared range rather than from the legacy version constant
// because migrations.test.mjs's gate scan forbids any file under web/src from
// naming that constant, and weakening that scan is not available here.
const UNREADABLE_BOARD_SCHEMA_VERSION = Math.min(...PERSISTED_BOARD_VERSIONS) - 1;
function issue(number: number, state: 'open' | 'closed' = 'open'): BoardIssue {
  return { number, title: `Issue ${number}`, body: '', state, createdAt: timestamp, updatedAt: timestamp, messages: [] };
}
function resource(overrides: Partial<BoardResource> = {}): BoardResource {
  return { host: 'lubko://server', path: '/protected/path', issueNumbers: [1], createdAt: timestamp, updatedAt: timestamp, ...overrides };
}

describe('board schema', () => {
  it('rejects non-canonical schemas', () => {
    expect(() => parseBoard({ schemaVersion: UNREADABLE_BOARD_SCHEMA_VERSION, nextIssueNumber: 1, issues: [], resources: [], targets: [], dispatches: [] })).toThrow(`schema version is ${UNREADABLE_BOARD_SCHEMA_VERSION}, but this build reads schema version ${BOARD_SCHEMA_VERSION}`);
  });

  it('enforces exact keys, canonical resources, and referenced issues', () => {
    const valid: Board = { schemaVersion: BOARD_SCHEMA_VERSION, nextIssueNumber: 3, issues: [issue(1), issue(2, 'closed')], resources: [resource({ issueNumbers: [1, 2] })], targets: [], dispatches: [] };
    expect(parseBoard(valid)).toEqual(valid);
    expect(() => parseBoard({ ...valid, resources: [resource({ issueNumbers: [3] })] })).toThrow('issueNumbers index 0: found a number, expected an issue number that exists on this board');
    expect(() => parseBoard({ ...valid, resources: [resource(), resource()] })).toThrow('duplicate resource');
    expect(() => parseBoard({ ...valid, extra: true })).toThrow("wrong keys (unexpected 'extra')");
  });

  it('canonicalizes and validates hosts and paths', () => {
    expect(canonicalHost(' lubko://server ')).toBe('lubko://server');
    expect(canonicalPath(' /a/b ')).toBe('/a/b');
    expect(canonicalPath('/')).toBe('/');
    for (const host of ['', 'https://server', 'lubko://', 'lubko://server/', 'lubko://server?x', 'lubko://server#x', 'lubko://server\\x', 'lubko://ser ver']) expect(() => canonicalHost(host)).toThrow();
    expect(canonicalHost('lubko://server-name')).toBe('lubko://server-name');
    for (const path of ['', 'a/b', '/a/../b', '/a//b', '/a/.', '/a/b/']) expect(() => canonicalPath(path)).toThrow();
  });

  it('derives protection from open dependent issues and preserves closed dependencies', () => {
    const dependencies = resource({ issueNumbers: [1, 2] });
    expect(resourceState(dependencies, [issue(1), issue(2, 'closed')])).toBe('protected');
    expect(resourceState(dependencies, [issue(1, 'closed'), issue(2, 'closed')])).toBe('collectible');
  });
});
