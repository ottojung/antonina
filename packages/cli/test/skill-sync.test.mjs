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
    'description: Coordinate recurring software work through the Antonina board queue and append-only issue history.',
    '---',
    '',
    '',
  ].join('\n');

  assert.equal(skill, frontmatter + orchestrator);
  assert.equal(installedResources, resources);
});

test('orchestrator policy preserves project breadth before intra-issue depth', () => {
  const orchestrator = read('../../../docs/skills/orchestrator.md');

  assert.match(orchestrator, /Project breadth wave/);
  assert.match(orchestrator, /Issue breadth wave/);
  assert.match(orchestrator, /Intra-issue depth wave/);
  assert.match(orchestrator, /unrepresented actionable project remains/);
  assert.match(orchestrator, /monopolization licenses/);

  const projectBreadth = orchestrator.indexOf('**Project breadth wave.**');
  const issueBreadth = orchestrator.indexOf('**Issue breadth wave.**');
  const intraIssueDepth = orchestrator.indexOf('**Intra-issue parallelism.**');
  assert.ok(projectBreadth >= 0 && issueBreadth > projectBreadth && intraIssueDepth > issueBreadth);
});
