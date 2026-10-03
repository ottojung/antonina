import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.XDG_STATE_HOME = process.env.XDG_STATE_HOME || mkdtempSync(join(tmpdir(), 'xdg-state-'))
process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || mkdtempSync(join(tmpdir(), 'xdg-config-'))

const {
  readAdminRef,
  redactCredentials,
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

// The CLI deliberately exits nonzero for anything that is not clean, so run it
// without throwing and hand back stdout and the exit code for assertion.
function runCli(args, opts) {
  const res = spawnSync(process.execPath, [join(import.meta.dirname, 'reconcile-handoff.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env },
    ...opts,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// A loopback HTTP server that answers every request with 401. git has no
// credential helper and no terminal, so it asks for a password and fails with
// `could not read Password for '<url>'` — the message that echoes URL
// userinfo. Started as a child process so the reconciler can be run
// synchronously while the server answers, and killed in the caller's cleanup.
function startAuthServer() {
  const source = `
const http = require('node:http')
const srv = http.createServer((req, res) => {
  res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' })
  res.end('no')
})
srv.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT:' + srv.address().port + '\\n')
})
`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  const cleanup = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let buf = ''
    const timer = setTimeout(() => {
      cleanup()
      rejectPromise(new Error('auth server did not report a port'))
    }, 10_000)
    child.stdout.on('data', (chunk) => {
      buf += String(chunk)
      const m = /PORT:(\d+)/.exec(buf)
      if (!m) return
      clearTimeout(timer)
      child.stdout.removeAllListeners('data')
      resolvePromise({ port: Number(m[1]), cleanup })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      cleanup()
      rejectPromise(err)
    })
  })
}

function firstLine(stdout) {
  return JSON.parse(stdout.trim().split('\n')[0])
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
  // The read succeeded; absence is a fact about the admin side.
  assert.equal(readAdminRef(f.work, 'origin', 'release/does-not-exist').reachable, true)
  assert.equal(exitCodeFor(results), EXIT_UNEVALUABLE)
})

// Correction 1: an unreachable remote is a transport failure, never absence.
test('an unreachable administrative side is never reported as an absent ref', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  const claimed = commitOn(f.work, 'work', 'feature/u')
  // Break reachability by pointing the remote at a path that does not exist.
  run(f.work, ['remote', 'set-url', 'origin', join(f.root, 'nonexistent.git')])

  const admin = readAdminRef(f.work, 'origin', 'main')
  assert.equal(admin.reachable, false)
  assert.equal(admin.present, false)

  const { results } = check([
    { issue: 43, branch: 'feature/u', commit: claimed, targetBranch: 'main' },
  ])
  assert.equal(results[0].verdict, 'admin-unreachable')
  assert.notEqual(results[0].verdict, 'target-ref-absent')
  assert.match(results[0].why, /could not be read from the administrative side/)
  assert.ok(results[0].why.length > 'could not be read from the administrative side: '.length)
  assert.equal(exitCodeFor(results), EXIT_UNEVALUABLE)

  // The same, through the CLI, so the git error reaches the emitted line.
  const claimsPath = join(f.root, 'claims.json')
  writeFileSync(
    claimsPath,
    JSON.stringify([{ issue: 43, branch: 'feature/u', commit: claimed, targetBranch: 'main' }]),
  )
  const cli = runCli([claimsPath, '--repo', f.work])
  const line = firstLine(cli.stdout)
  assert.equal(line.verdict, 'admin-unreachable')
  assert.notEqual(line.verdict, 'target-ref-absent')
  assert.match(line.why, /nonexistent/)
  assert.equal(cli.status, EXIT_UNEVALUABLE)
})

// Correction 2: supersession must not downgrade a worse single-claim verdict.
test('supersession does not downgrade a claim that is not its branch head', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  run(f.work, ['checkout', '--quiet', '-B', 'main'])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'base bump'])
  run(f.work, ['push', '--quiet', 'origin', 'main:refs/heads/main'])
  commitOn(f.work, 'work', 'feature/a')
  // The local branch has a commit the claim does not name.
  const stale = run(f.work, ['rev-parse', 'feature/a^'])
  // A later claim that carries the older one forward.
  const newer = commitOn(f.work, 'carried forward', 'feature/b')

  const alone = check([{ issue: 43, branch: 'feature/a', commit: stale, targetBranch: 'main' }])
  assert.equal(alone.results[0].verdict, 'claim-is-not-the-branch-head')
  const aloneExit = exitCodeFor(alone.results)

  const paired = check([
    { issue: 43, branch: 'feature/a', commit: stale, targetBranch: 'main' },
    { issue: 44, branch: 'feature/b', commit: newer, targetBranch: 'main' },
  ])
  const first = paired.results.find((r) => r.issue === 43)
  assert.equal(first.verdict, 'superseded-by-later-claim')
  // The worse single-claim finding is retained and still counted.
  assert.equal(first.retainedVerdict, 'claim-is-not-the-branch-head')
  assert.deepEqual(first.supersededBy, { issue: 44, commit: newer })
  assert.match(first.why, /superseded by issue 44/)
  assert.match(first.why, /branch feature\/a is at/)
  // Adding an unrelated claim must never lower the exit code.
  assert.ok(
    exitCodeFor(paired.results) >= aloneExit,
    `paired exit ${exitCodeFor(paired.results)} must not be below alone exit ${aloneExit}`,
  )
  assert.equal(exitCodeFor(paired.results), EXIT_DISAGREE)
})

// Correction 3: a published claim branch at a different commit contradicts the
// claim and must not be reported as `landed`.
test('a claim branch published at a different commit is not reported as landed', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  const claimed = commitOn(f.work, 'work', 'feature/x')
  run(f.work, ['push', '--quiet', 'origin', 'feature/x:refs/heads/main'])
  // The administrative claim branch is published at something else, while the
  // local feature/x branch still stands at the claimed commit.
  run(f.work, ['checkout', '--quiet', '-B', 'admin-only', claimed])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'other admin work'])
  const otherHead = run(f.work, ['rev-parse', 'HEAD'])
  run(f.work, ['push', '--quiet', 'origin', 'admin-only:refs/heads/feature/x'])
  run(f.work, ['checkout', '--quiet', 'feature/x'])
  assert.notEqual(otherHead, claimed)

  const { results } = check([
    { issue: 43, branch: 'feature/x', commit: claimed, targetBranch: 'main' },
  ])
  assert.notEqual(results[0].verdict, 'landed')
  assert.equal(results[0].verdict, 'claim-branch-diverged')
  assert.equal(results[0].adminClaimBranchCommit, otherHead)
  assert.match(results[0].nextStep, /disagree/)
  assert.equal(exitCodeFor(results), EXIT_DISAGREE)
})

// Correction 4: the computed divergence evidence must reach the operator.
test('divergence evidence is emitted, not just computed', (t) => {
  const f = fixture()
  fixtureWork = f.work
  t.after(f.cleanup)
  const shared = run(f.work, ['rev-parse', 'HEAD'])
  run(f.work, ['checkout', '--quiet', '-B', 'main'])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'admin side'])
  run(f.work, ['push', '--quiet', 'origin', 'main:refs/heads/main'])
  run(f.work, ['checkout', '--quiet', '-B', 'feature/x', shared])
  run(f.work, ['commit', '--quiet', '--allow-empty', '-m', 'local side'])
  const localClaim = run(f.work, ['rev-parse', 'HEAD'])
  run(f.work, ['push', '--quiet', 'origin', 'feature/x:refs/heads/feature/x'])

  const claimsPath = join(f.root, 'claims.json')
  writeFileSync(
    claimsPath,
    JSON.stringify([{ issue: 43, branch: 'feature/x', commit: localClaim, targetBranch: 'main' }]),
  )
  const cli = runCli([claimsPath, '--repo', f.work])
  const line = firstLine(cli.stdout)
  assert.equal(line.verdict, 'diverged')
  assert.equal(cli.status, EXIT_DISAGREE)
  assert.equal(line.evidence.length, 2)
  assert.match(line.evidence.join('\n'), /claim-only commits: 1/)
  assert.match(line.evidence.join('\n'), /admin-only commits: 1/)
})

// R1: a credential embedded in a remote URL must never leave this process.
// git prints `could not read Password for 'https://<token>@host'` on stderr,
// and that text is interpolated into verdict.why, which the CLI writes to
// stdout. The token below is synthetic and PAT-shaped; no real credential is
// present in this repository.
const FAKE_PAT = 'ghp_TESTfakePAT0000000000000000000000abcd'

// The leak path specifically: an http remote that answers 401. git then has
// the token as the URL userinfo and no helper to supply a password, so it
// prints `could not read Password for 'http://<token>@host:port'` with the
// token verbatim. (On a connection-refused git redacts the userinfo itself, so
// that path is not the one being pinned.)
function credentialRemoteURL(port) {
  return `http://${FAKE_PAT}@127.0.0.1:${port}/repo.git`
}

test('a credential-bearing git error is redacted from every output path', async (t) => {
  const server = await startAuthServer()
  t.after(server.cleanup)
  const f = fixture()
  t.after(f.cleanup)
  const claimed = commitOn(f.work, 'work', 'feature/secret')
  run(f.work, ['remote', 'set-url', 'origin', credentialRemoteURL(server.port)])

  // Confirm the fixture really produces the credential-bearing message, so the
  // assertions below cannot pass by never reaching the leak path.
  const raw = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
    cwd: f.work,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.notEqual(raw.status, 0, 'git must fail against the 401 remote')
  assert.ok(
    String(raw.stderr).includes(FAKE_PAT),
    'git is expected to echo the URL userinfo verbatim; this is the leak being closed',
  )

  const claimsPath = join(f.root, 'claims.json')
  writeFileSync(
    claimsPath,
    JSON.stringify([{ issue: 43, branch: 'feature/secret', commit: claimed, targetBranch: 'main' }]),
  )
  const cli = runCli([claimsPath, '--repo', f.work])
  const line = firstLine(cli.stdout)
  // The verdict is unchanged: a credential in the URL is a transport failure.
  assert.equal(line.verdict, 'admin-unreachable')
  assert.equal(cli.status, EXIT_UNEVALUABLE)
  // The diagnostic survives redaction, so the failure is still diagnosable.
  assert.match(line.why, /could not be read from the administrative side/)
  assert.match(line.why, /<redacted>/)
  // The credential is absent from every path a consumer can read: the emitted
  // line, stdout as a whole, stderr, and the exit code.
  for (const [name, text] of [
    ['emitted line', JSON.stringify(line)],
    ['stdout', cli.stdout],
    ['stderr', cli.stderr],
    ['exit status', String(cli.status)],
  ]) {
    assert.ok(
      !text.includes(FAKE_PAT),
      `credential leaked into ${name}: ${text.slice(0, 300)}`,
    )
    assert.ok(!/ghp_[A-Za-z0-9]{16,}/.test(text), `credential-shaped token in ${name}`)
  }
})

test('redaction is unit-level, on both git output streams and bare tokens', () => {
  const url = credentialRemoteURL(8080)
  assert.equal(
    redactCredentials(`fatal: could not read Password for '${url}': No such device`),
    "fatal: could not read Password for 'http://<redacted>@127.0.0.1:8080/repo.git': No such device",
  )
  // A token that is not inside a URL is redacted too.
  assert.equal(redactCredentials(`token ${FAKE_PAT} rejected`), 'token <redacted> rejected')
  assert.equal(
    redactCredentials('https://github_pat_11ABCDEFG0abcdefghijkl_xyzTOKEN0123456789@github.com'),
    'https://<redacted>@github.com',
  )
  // Non-credential text is untouched, so diagnostics are not mangled.
  assert.equal(redactCredentials('fatal: repository not found'), 'fatal: repository not found')
  assert.equal(redactCredentials(undefined), '')
})

// R2: "read succeeded, printed a line I could not parse" is not absence.
// A sha256-object-format remote prints 64-hex ref lines that this sha1 reader
// cannot parse; the ref exists, so reporting it as absent is false.
test('a ref that exists but cannot be parsed is not reported as absent', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  fixtureWork = f.work
  const claimed = commitOn(f.work, 'work', 'feature/sha256')

  // A real administrative side in a different object format. Its refs exist and
  // ls-remote exits 0, but the lines are 64 hex characters.
  const shaRemote = join(f.root, 'sha256.git')
  const shaWork = join(f.root, 'sha256work')
  mkdirSync(shaWork, { recursive: true })
  run(shaWork, ['init', '--quiet', '--initial-branch', 'main', '--object-format=sha256'])
  run(shaWork, ['config', 'user.email', 'test@example.invalid'])
  run(shaWork, ['config', 'user.name', 'test'])
  run(shaWork, ['commit', '--quiet', '--allow-empty', '-m', 'root'])
  run(shaWork, ['init', '--bare', '--quiet', '--object-format=sha256', shaRemote])
  run(shaWork, ['remote', 'add', 'origin', shaRemote])
  run(shaWork, ['push', '--quiet', '-u', 'origin', 'main'])
  const shaHead = run(shaWork, ['rev-parse', 'HEAD'])
  assert.equal(shaHead.length, 64)

  run(f.work, ['remote', 'set-url', 'origin', shaRemote])

  const admin = readAdminRef(f.work, 'origin', 'main')
  assert.equal(admin.reachable, true, 'the read itself succeeded')
  assert.equal(admin.unparseable, true, 'but its output was not parseable')
  assert.equal(admin.present, false, 'and so no claim is made either way')

  const { results } = check([
    { issue: 43, branch: 'feature/sha256', commit: claimed, targetBranch: 'main' },
  ])
  assert.notEqual(results[0].verdict, 'target-ref-absent')
  assert.notEqual(results[0].verdict, 'landed')
  assert.equal(results[0].verdict, 'admin-ref-unreadable')
  assert.match(results[0].nextStep, /absence is not concluded/)
  assert.equal(exitCodeFor(results), EXIT_UNEVALUABLE)

  // Same through the CLI, including the exit code a consumer branches on.
  const claimsPath = join(f.root, 'claims.json')
  writeFileSync(
    claimsPath,
    JSON.stringify([{ issue: 43, branch: 'feature/sha256', commit: claimed, targetBranch: 'main' }]),
  )
  const cli = runCli([claimsPath, '--repo', f.work])
  assert.equal(cli.status, EXIT_UNEVALUABLE)
  assert.notEqual(cli.status, EXIT_OK)
  assert.equal(firstLine(cli.stdout).verdict, 'admin-ref-unreadable')
})

// R2 at the claim-branch side, via the injectable reader.
test('an unparseable claim-branch ref is not reported as an absent target', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const claimed = commitOn(f.work, 'work', 'feature/inject')
  const { results } = reconcileAll(
    [{ issue: 43, branch: 'feature/inject', commit: claimed, targetBranch: 'main' }],
    {
      repo: f.work,
      remote: 'origin',
      refReader: (repo, remote, ref) =>
        ref === 'feature/inject'
          ? { ref, reachable: true, present: false, unparseable: true, commit: null, error: 'unparseable ls-remote output' }
          : { ref, reachable: true, present: true, unparseable: false, commit: run(repo, ['rev-parse', 'main']), error: null },
    },
  )
  assert.equal(results[0].verdict, 'admin-ref-unreadable')
  assert.notEqual(results[0].verdict, 'target-ref-absent')
  assert.equal(exitCodeFor(results), EXIT_UNEVALUABLE)
})

// R3: the target-ref reachability guard. The claim-branch read succeeds while
// the target read fails, so only this guard can decide the verdict.
test('a failed target-ref read is admin-unreachable, never target-ref-absent', (t) => {
  const f = fixture()
  t.after(f.cleanup)
  const claimed = commitOn(f.work, 'work', 'feature/guard')
  const targetCommit = run(f.work, ['rev-parse', 'main'])

  // The claim branch reads back exactly as claimed; only the target read fails.
  const { results } = reconcileAll(
    [{ issue: 43, branch: 'feature/guard', commit: claimed, targetBranch: 'main' }],
    {
      repo: f.work,
      remote: 'origin',
      refReader: (repo, remote, ref) =>
        ref === 'main'
          ? { ref, reachable: false, present: false, unparseable: false, commit: null, error: 'transport error' }
          : { ref, reachable: true, present: true, unparseable: false, commit: claimed, error: null },
    },
  )
  // Guard ordering is the point: the claim branch is readable and matches, so
  // nothing short of the target guard produces this verdict.
  assert.equal(results[0].verdict, 'admin-unreachable')
  assert.notEqual(results[0].verdict, 'target-ref-absent')
  assert.notEqual(results[0].verdict, 'landed')
  assert.match(results[0].why, /transport error/)
  assert.equal(exitCodeFor(results), EXIT_UNEVALUABLE)
  assert.notEqual(exitCodeFor(results), EXIT_OK)
  assert.ok(targetCommit)

  // A reader that omits `reachable` entirely is also not a successful read.
  const legacy = reconcileAll(
    [{ issue: 43, branch: 'feature/guard', commit: claimed, targetBranch: 'main' }],
    {
      repo: f.work,
      remote: 'origin',
      refReader: (repo, remote, ref) =>
        ref === 'main'
          ? { ref, present: false, error: 'legacy reader shape' }
          : { ref, reachable: true, present: true, unparseable: false, commit: claimed, error: null },
    },
  )
  assert.equal(legacy.results[0].verdict, 'admin-unreachable')
  assert.notEqual(legacy.results[0].verdict, 'target-ref-absent')
})
