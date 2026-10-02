import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.XDG_STATE_HOME = process.env.XDG_STATE_HOME || mkdtempSync(join(tmpdir(), 'xdg-state-'))
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || mkdtempSync(join(tmpdir(), 'xdg-config-'))

const {
  readAdminRef,
  reconcileAll,
  exitCodeFor,
  EXIT_OK,
  EXIT_DISAGREE,
  EXIT_UNPUBLISHED,
  EXIT_UNEVALUABLE,
} = await import('./reconcile-handoff.mjs')

function run(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// A local file remote stands in for the GitHub administrative side. It is
// created fresh per test, so no test can read or move a real remote ref.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-handoff-'))
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  run(root, ['init', '--bare', '--quiet', remote])
  run(work, ['init', '--quiet', '--initial-branch', 'main'])
  run(work, ['config', 'user.email', 'test@example.invalid'])
  run(work, ['config', 'user.name', 'test'])
  run(work, ['commit', '--quiet', '--allow-empty', '-m', 'root'])
  run(work, ['branch', '-M', 'main'])
  run(work, ['remote', 'add', 'origin', remote])
  run(work, ['push', '--quiet', '-u', 'origin', 'main'])
  return { root, remote, work, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function commitOn(work, message, branch) {
  if (branch) run(work, ['checkout', '--quiet', '-B', branch])
  run(work, ['commit', '--quiet', '--allow-empty', '-m', message])
  const head = run(work, ['rev-parse', 'HEAD'])
  if (branch) run(work, ['push', '--quiet', 'origin', `${branch}:refs/heads/${branch}`])
  return head
}

function check(claims) {
  return reconcileAll(claims, { repo: fixtureWork, remote: 'origin' })
}

let fixtureWork

test('a claim that is exactly the administrative head reconciles with no action', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  commitOn(f.work, 'work', 'feature/x')
  // The administrative side has taken the exact commit under claim.
  run(f.work, ['push', '--quiet', 'origin', 'feature/x:refs/heads/main'])
  const claimed = run(f.work, ['rev-parse', 'feature/x'])

  const { results } = check([
    { issue: 43, branch: 'feature/x', commit: claimed, targetBranch: 'main' },
  ])
  assert.equal(results.length, 1)
  assert.equal(results[0].verdict, 'landed')
  assert.equal(results[0].adminTargetCommit, claimed)
  assert.equal(exitCodeFor(results), EXIT_OK)
})

test('a claim that is durable but behind the administrative head is stale, not a conflict', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  const claimed = commitOn(f.work, 'work', 'feature/x')
  commitOn(f.work, 'later admin commit', 'main')

  const { results } = check([
    { issue: 43, branch: 'feature/x', commit: claimed, targetBranch: 'main' },
  ])
  assert.equal(results[0].verdict, 'landed-and-superseded')
  assert.equal(exitCodeFor(results), EXIT_OK)
})

// The adversarial case. Local claim and administrative record both carry
// commits the other lacks. The tool must not resolve this by preference.
test('a diverged claim is reported as a disagreement, with neither side preferred', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  const shared = run(f.work, ['rev-parse', 'HEAD'])
  run(f.work, ['checkout', '--quiet', '-B', 'main'])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'admin side'])
  const adminHead = run(f.work, ['rev-parse', 'HEAD'])
  run(f.work, ['push', '--quiet', 'origin', 'main:refs/heads/main'])
  run(f.work, ['checkout', '--quiet', '-B', 'feature/x', shared])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'local side'])
  const localClaim = run(f.work, ['rev-parse', 'HEAD'])
  run(f.work, ['push', '--quiet', 'origin', 'feature/x:refs/heads/feature/x'])

  const admin = readAdminRef(f.work, 'origin', 'main')
  assert.equal(admin.commit, adminHead)

  const { results } = check([
    { issue: 43, branch: 'feature/x', commit: localClaim, targetBranch: 'main' },
  ])
  assert.equal(results[0].verdict, 'diverged')
  assert.match(results[0].why, /each contain commits the other does not/)
  // Both sides are named: the claim and the administrative head.
  assert.equal(results[0].adminTargetCommit, adminHead)
  assert.equal(results[0].commit, localClaim)
  assert.equal(results[0].evidence.length, 2)
  assert.match(results[0].nextStep, /neither side wins/)
  // Exit code escalates to the human-decision code, not to "reconciled".
  assert.equal(exitCodeFor(results), EXIT_DISAGREE)
})

test('a claim that exists only locally is unpublished, not silently landed', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  run(f.work, ['checkout', '--quiet', '-B', 'main'])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'base bump'])
  run(f.work, ['push', '--quiet', 'origin', 'main:refs/heads/main'])
  const claimed = commitOn(f.work, 'unpublished work', 'feature/y')

  const { results } = check([
    { issue: 43, branch: 'feature/y', commit: claimed, targetBranch: 'main' },
  ])
  assert.equal(results[0].verdict, 'unpublished')
  assert.equal(exitCodeFor(results), EXIT_UNPUBLISHED)
})

test('two claims against one target at different commits are a local disagreement', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  run(f.work, ['checkout', '--quiet', '-B', 'main'])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'base bump'])
  run(f.work, ['push', '--quiet', 'origin', 'main:refs/heads/main'])
  const first = commitOn(f.work, 'first claim', 'feature/a')
  // A second, unrelated line for the same target: neither contains the other.
  const shared = run(f.work, ['rev-parse', 'main'])
  run(f.work, ['checkout', '--quiet', '-B', 'feature/b', shared])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'second claim'])
  const second = run(f.work, ['rev-parse', 'HEAD'])

  const { results, duplicates } = check([
    { issue: 43, branch: 'feature/a', commit: first, targetBranch: 'main' },
    { issue: 44, branch: 'feature/b', commit: second, targetBranch: 'main' },
  ])
  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].claims.length, 2)
  for (const r of results) assert.equal(r.verdict, 'duplicate-claims-disagree')
  assert.equal(exitCodeFor(results), EXIT_DISAGREE)
})

test('two claims where one contains the other are supersession, not a conflict', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  run(f.work, ['checkout', '--quiet', '-B', 'main'])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'base bump'])
  run(f.work, ['push', '--quiet', 'origin', 'main:refs/heads/main'])
  const older = commitOn(f.work, 'first claim', 'feature/a')
  const newer = commitOn(f.work, 'carried forward', 'feature/b')

  const { results, duplicates } = check([
    { issue: 43, branch: 'feature/a', commit: older, targetBranch: 'main' },
    { issue: 44, branch: 'feature/b', commit: newer, targetBranch: 'main' },
  ])
  assert.equal(duplicates.length, 0)
  const first = results.find((r) => r.issue === 43)
  const second = results.find((r) => r.issue === 44)
  assert.equal(first.verdict, 'superseded-by-later-claim')
  assert.deepEqual(first.supersededBy, { issue: 44, commit: newer })
  assert.equal(second.verdict, 'unpublished')
})

test('a claim naming a commit that is not the branch head is refused', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  run(f.work, ['checkout', '--quiet', '-B', 'main'])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'base bump'])
  run(f.work, ['push', '--quiet', 'origin', 'main:refs/heads/main'])
  commitOn(f.work, 'work', 'feature/z')
  const older = run(f.work, ['rev-parse', 'feature/z^'])

  const { results } = check([
    { issue: 43, branch: 'feature/z', commit: older, targetBranch: 'main' },
  ])
  assert.equal(results[0].verdict, 'claim-is-not-the-branch-head')
  assert.equal(exitCodeFor(results), EXIT_DISAGREE)
})

test('a claim whose commit is unknown is unevaluable, never assumed landed', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  const missing = '0'.repeat(40)
  const { results } = check([
    { issue: 43, branch: 'feature/none', commit: missing, targetBranch: 'main' },
  ])
  assert.equal(results[0].verdict, 'unevaluable')
  assert.notEqual(exitCodeFor(results), EXIT_OK)
})

test('an absent target ref is a fact, and is not created', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  const claimed = commitOn(f.work, 'work', 'feature/q')
  const { results } = check([
    { issue: 43, branch: 'feature/q', commit: claimed, targetBranch: 'release/does-not-exist' },
  ])
  assert.equal(results[0].verdict, 'target-ref-absent')
  assert.equal(readAdminRef(f.work, 'origin', 'release/does-not-exist').present, false)
  assert.equal(exitCodeFor(results), EXIT_UNEVALUABLE)
})