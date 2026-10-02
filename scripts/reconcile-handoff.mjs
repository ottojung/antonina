#!/usr/bin/env node
// Reconcile a local handoff claim against GitHub administrative state.
//
// A claim is what a work item asserts locally: an issue, a branch, an exact
// commit, and the branch the work is meant to land on. The administrative
// state is what the hosting provider actually holds for those refs.
//
// This tool only reads. It never pushes, never force-writes, never opens or
// updates a pull request, and never writes to a board. A disagreement is
// reported as a disagreement; neither side is silently preferred.
//
// Usage:
//   node scripts/reconcile-handoff.mjs <claims.json> [--remote <name>] [--repo <dir>]
//
// Exit codes:
//   0  every claim reconciles; no administrative action is implied
//   2  usage or input error
//   3  unresolved disagreement; a human decision is required before any write
//   4  a claim is complete locally but absent from the administrative state;
//      publication is possible on this host but is not authorised by this tool
//   5  at least one claim could not be evaluated (unknown commit, missing ref)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const EXIT_OK = 0
export const EXIT_USAGE = 2
export const EXIT_DISAGREE = 3
export const EXIT_UNPUBLISHED = 4
export const EXIT_UNEVALUABLE = 5

function git(repo, args, { allowFailure = false } = {}) {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    }
  } catch (err) {
    if (!allowFailure) throw err
    return { ok: false, out: String(err.stdout ?? '').trim(), status: err.status ?? null }
  }
}

// The administrative state of one ref, read straight from the provider.
// Absence is a value, not an error: a ref that is not there is a fact about
// the admin side that the caller has to reconcile against.
export function readAdminRef(repo, remote, ref) {
  const ls = git(repo, ['ls-remote', '--heads', remote, `refs/heads/${ref}`], {
    allowFailure: true,
  })
  if (!ls.ok) return { ref, present: false, commit: null, error: ls.out }
  const match = /^([0-9a-f]{40})\trefs\/heads\/(.+)$/.exec(ls.out)
  if (!match) return { ref, present: false, commit: null }
  return { ref, present: true, commit: match[1] }
}

function isAncestor(repo, older, newer) {
  const res = git(repo, ['merge-base', '--is-ancestor', older, newer], { allowFailure: true })
  return res.ok
}

function commitExists(repo, commit) {
  if (!/^[0-9a-f]{40}$/.test(String(commit ?? ''))) return false
  return git(repo, ['cat-file', '-e', `${commit}^{commit}`], { allowFailure: true }).ok
}

// Precedence, stated once so a reader can audit it:
//   The administrative state is authoritative for what EXISTS.
//   The local claim is authoritative for what was INTENDED.
//   Neither is authoritative for the other. A claim and a ref that are both
//   real but unrelated is a disagreement, not a merge to be resolved here.
export function reconcileClaim(claim, admin, repo) {
  const verdict = {
    issue: claim.issue ?? null,
    branch: claim.branch,
    commit: claim.commit,
    targetBranch: claim.targetBranch,
    localHead: null,
    adminTargetCommit: admin.present ? admin.commit : null,
    adminClaimBranchCommit: admin.claimRef.present ? admin.claimRef.commit : null,
    verdict: null,
    why: '',
    nextStep: '',
    evidence: [],
  }

  if (!commitExists(repo, claim.commit)) {
    verdict.verdict = 'unevaluable'
    verdict.why = `commit ${claim.commit} is not present in this repository`
    verdict.nextStep = 'recover the reviewed commit before any administrative action'
    return verdict
  }

  const head = git(repo, ['rev-parse', claim.branch], { allowFailure: true })
  verdict.localHead = head.ok ? head.out : null
  if (head.ok && head.out !== claim.commit) {
    verdict.verdict = 'claim-is-not-the-branch-head'
    verdict.why = `branch ${claim.branch} is at ${head.out}, the claim names ${claim.commit}`
    verdict.nextStep = 'resolve the local branch and the claim before publishing anything'
    return verdict
  }

  if (!admin.present) {
    // Admin side has no such branch at all. The claim cannot be stale or
    // superseded; it is simply not there.
    verdict.verdict = 'target-ref-absent'
    verdict.why = `${admin.ref} does not exist on the administrative side`
    verdict.nextStep =
      'the target branch must be created or the claim retargeted; this tool creates nothing'
    return verdict
  }

  const target = admin.commit
  const onTarget = isAncestor(repo, claim.commit, target)

  if (!onTarget) {
    const targetHasClaim = isAncestor(repo, target, claim.commit)
    if (targetHasClaim) {
      // Strictly ahead locally, nothing on the admin side that is not claimed.
      verdict.verdict = 'unpublished'
      verdict.why = `claim ${claim.commit} is ahead of ${admin.ref} at ${target}; the administrative state does not contain it`
      verdict.nextStep =
        'human authorises publication, an agent pushes the named commit, a human opens the pull request'
      verdict.evidence.push(`git rev-list --count ${target}..${claim.commit} = ahead`)
      return verdict
    }
    // Both sides carry commits the other does not. This is the case that must
    // never be resolved by preference.
    const ahead = git(repo, ['rev-list', '--count', `${target}..${claim.commit}`], {
      allowFailure: true,
    })
    const behind = git(repo, ['rev-list', '--count', `${claim.commit}..${target}`], {
      allowFailure: true,
    })
    verdict.verdict = 'diverged'
    verdict.why = `claim ${claim.commit} and ${admin.ref} at ${target} each contain commits the other does not`
    verdict.nextStep =
      'neither side wins; reconcile the two lines deliberately and re-run this check before publishing'
    verdict.evidence.push(`claim-only commits: ${ahead.ok ? ahead.out : 'unknown'}`)
    verdict.evidence.push(`admin-only commits: ${behind.ok ? behind.out : 'unknown'}`)
    return verdict
  }

  if (claim.commit === target) {
    verdict.verdict = 'landed'
    verdict.why = `${admin.ref} is exactly the claimed commit`
    verdict.nextStep = 'none; the claim is already the administrative state'
    return verdict
  }

  // Ancestor but not the head: the claim is durable and later admin commits
  // moved the line on. Not a conflict, but the claim is stale as a description
  // of the current state.
  const since = git(repo, ['rev-list', '--count', `${claim.commit}..${target}`], {
    allowFailure: true,
  })
  verdict.verdict = 'landed-and-superseded'
  verdict.why = `claim is an ancestor of ${admin.ref} at ${target}, ${since.ok ? since.out : '?'} commits behind its head`
  verdict.nextStep =
    'no publication action; re-verify against the current head if the claim is cited as current state'
  return verdict
}

// Two claims against the same target at different commits. That is only a
// disagreement when neither claim supersedes the other: if one claimed commit
// is an ancestor of another, the older claim has been carried forward and the
// record should say so by name rather than reporting a conflict.
export function reconcileDuplicateClaims(claims, results, repo) {
  const byTarget = new Map()
  for (const claim of claims) {
    const key = `${claim.targetBranch}`
    if (!byTarget.has(key)) byTarget.set(key, [])
    byTarget.get(key).push(claim)
  }
  const duplicates = []
  for (const [target, group] of byTarget) {
    if (group.length < 2) continue
    const commits = new Set(group.map((c) => c.commit))
    if (commits.size < 2) continue

    const superseded = new Map()
    for (const older of group) {
      for (const newer of group) {
        if (older.commit === newer.commit) continue
        if (commitExists(repo, older.commit) && commitExists(repo, newer.commit) &&
            isAncestor(repo, older.commit, newer.commit)) {
          superseded.set(older.commit, newer)
        }
      }
    }

    if (superseded.size > 0 && superseded.size < commits.size) {
      for (const [olderCommit, newer] of superseded) {
        const r = results.find((x) => x.commit === olderCommit && x.targetBranch === target)
        if (!r) continue
        r.verdict = 'superseded-by-later-claim'
        r.why = `issue ${newer.issue} claims ${newer.commit}, which contains this claim's ${olderCommit}`
        r.nextStep = `issue ${r.issue} may cite its commit only as history, not as current state`
        r.supersededBy = { issue: newer.issue ?? null, commit: newer.commit }
      }
      continue
    }

    duplicates.push({ target, claims: group.map((c) => ({ issue: c.issue, commit: c.commit })) })
    for (const r of results) {
      if (r.targetBranch === target) {
        r.verdict = 'duplicate-claims-disagree'
        r.why = `${group.length} claims target ${target} at ${commits.size} different commits, none an ancestor of another`
        r.nextStep =
          'neither claim wins; one issue supersedes the other in the record before any publication'
      }
    }
  }
  return duplicates
}

export function reconcileAll(claims, { repo, remote, refReader = readAdminRef }) {
  const results = claims.map((claim) => {
    const admin = {
      ref: `refs/heads/${claim.targetBranch}`,
      ...refReader(repo, remote, claim.targetBranch),
    }
    const claimRef = refReader(repo, remote, claim.branch)
    return reconcileClaim(claim, { ...admin, claimRef }, repo)
  })
  const duplicates = reconcileDuplicateClaims(claims, results, repo)
  return { results, duplicates }
}

export function exitCodeFor(results) {
  let worst = EXIT_OK
  const rank = { [EXIT_OK]: 0, [EXIT_UNPUBLISHED]: 1, [EXIT_UNEVALUABLE]: 2, [EXIT_DISAGREE]: 3 }
  const byVerdict = {
    landed: EXIT_OK,
    'landed-and-superseded': EXIT_OK,
    unpublished: EXIT_UNPUBLISHED,
    unevaluable: EXIT_UNEVALUABLE,
    'superseded-by-later-claim': EXIT_OK,
    'claim-is-not-the-branch-head': EXIT_DISAGREE,
    'target-ref-absent': EXIT_UNEVALUABLE,
    diverged: EXIT_DISAGREE,
    'duplicate-claims-disagree': EXIT_DISAGREE,
  }
  for (const r of results) {
    const code = byVerdict[r.verdict] ?? EXIT_UNEVALUABLE
    if (rank[code] > rank[worst]) worst = code
  }
  return worst
}

function parseArgs(argv) {
  const out = { file: null, remote: 'origin', repo: process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--remote') out.remote = argv[++i]
    else if (arg === '--repo') out.repo = argv[++i]
    else if (arg === '--help' || arg === '-h') return null
    else if (!out.file) out.file = arg
    else throw new Error(`unexpected argument ${arg}`)
  }
  return out.file ? out : null
}

function main(argv) {
  const args = parseArgs(argv)
  if (!args) {
    process.stderr.write(
      'usage: node scripts/reconcile-handoff.mjs <claims.json> [--remote <name>] [--repo <dir>]\n',
    )
    return EXIT_USAGE
  }
  let doc
  try {
    doc = JSON.parse(readFileSync(resolve(args.file), 'utf8'))
  } catch (err) {
    process.stderr.write(`cannot read claims: ${err.message}\n`)
    return EXIT_USAGE
  }
  const claims = Array.isArray(doc) ? doc : doc.claims
  if (!Array.isArray(claims) || claims.length === 0) {
    process.stderr.write('claims file must contain a non-empty "claims" array\n')
    return EXIT_USAGE
  }
  for (const claim of claims) {
    if (!claim?.branch || !claim?.commit || !claim?.targetBranch) {
      process.stderr.write('each claim needs branch, commit and targetBranch\n')
      return EXIT_USAGE
    }
  }

  const { results, duplicates } = reconcileAll(claims, { repo: args.repo, remote: args.remote })
  for (const r of results) {
    process.stdout.write(
      `${JSON.stringify({ issue: r.issue, verdict: r.verdict, why: r.why, nextStep: r.nextStep })}\n`,
    )
  }
  if (duplicates.length > 0) {
    process.stdout.write(`${JSON.stringify({ duplicateClaims: duplicates })}\n`)
  }
  return exitCodeFor(results)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}