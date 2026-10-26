import { describe, expect, it } from 'vitest';
import { BOARD_SCHEMA_VERSION, parseBoard, PERSISTED_BOARD_VERSIONS, type Board, type BoardIssue } from './model';

// Derived so a schema bump moves the expected value with the reader. A version
// this build cannot read at all sits one below the oldest version it still
// reads, which keeps the refusal a refusal after a bump. This file derives from
// the readable set rather than from the legacy constant on purpose: the gate in
// packages/core/test/migrations.test.mjs fails any web source whose text names
// the legacy version constant, so a web file may not ask which version is
// legacy, only which versions this build reads.
const UNREADABLE_BOARD_SCHEMA_VERSION = PERSISTED_BOARD_VERSIONS[0] - 1;

const timestamp = '2026-09-24T00:00:00.000Z';
function issue(number: number, state: 'open' | 'closed' = 'open'): BoardIssue {
  return { number: String(number), title: `Issue ${number}`, body: '', state, createdAt: timestamp, updatedAt: timestamp, messages: [] };
}

describe('board schema', () => {
  it('rejects non-canonical schemas', () => {
    expect(() => parseBoard({ schemaVersion: UNREADABLE_BOARD_SCHEMA_VERSION, nextIssueNumber: 1, issues: [] })).toThrow(`schema version is ${UNREADABLE_BOARD_SCHEMA_VERSION}, but this build reads schema version ${BOARD_SCHEMA_VERSION}`);
  });

  it('enforces the canonical board key set', () => {
    const valid: Board = { schemaVersion: BOARD_SCHEMA_VERSION, nextIssueNumber: 3, issues: [issue(1), issue(2, 'closed')] };
    expect(parseBoard(valid)).toEqual(valid);
    expect(() => parseBoard({ ...valid, extra: true })).toThrow("wrong keys (unexpected 'extra')");
  });
});
