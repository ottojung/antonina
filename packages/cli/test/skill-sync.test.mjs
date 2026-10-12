import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

test('versioned OpenClaw skill stays in sync with canonical skill docs', () => {
  const skill = read('../../../skills/antonina-orchestrator/SKILL.md');
  const orchestrator = read('../../../docs/skills/orchestrator.md');
  const resources = read('../../../docs/skills/resources.md');
  const installedResources = read('../../../skills/antonina-orchestrator/resources.md');

  const frontmatter = [
    '---',
    'name: antonina-orchestrator',
    'description: Reason over the board work graph and delegate all useful independent fronts; leave repository, filesystem and implementation work to agents.',
    '---',
    '',
    '',
  ].join('\n');

  assert.equal(skill, frontmatter + orchestrator);
  assert.equal(installedResources, resources);
});
