import assert from 'node:assert/strict';
import test from 'node:test';
import { BoardApi } from '../dist/packages/core/src/api.js';
import { preparePublicCommand, publicCommandPaths } from '../dist/packages/cli/src/public-cli.js';
import { runBoardCommand } from '../dist/packages/cli/src/board.js';

test('the Antonina board and public CLI have no scheduler lease interface', async () => {
  assert.equal(Object.hasOwn(BoardApi.prototype, 'schedulerLease'), false);
  assert.equal(Object.hasOwn(BoardApi.prototype, 'schedulerLeases'), false);
  assert.equal(publicCommandPaths('board').some((path) => path.includes('lease')), false);
  assert.throws(() => preparePublicCommand('board', ['lease', 'list']), /unknown board command/);

  const errors = [];
  const code = await runBoardCommand(['lease', 'list'], {
    env: {}, home: '/nonexistent-antonina-test-home',
    io: { stdout() { assert.fail('unexpected output'); }, stderr(message) { errors.push(message); } },
    createClient() { return {}; },
  });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /unknown board command/);
});
