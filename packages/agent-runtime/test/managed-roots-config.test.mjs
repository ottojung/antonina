import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { realpath as realpathCall } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateManagedCandidate, validateManagedRoots } from '../dist/packages/core/src/managed-roots.js';
import {
  MANAGED_ROOTS_ENV,
  loadManagedRoots,
} from '../dist/packages/agent-runtime/src/managed-roots-config.js';

/**
 * The loader is the only producer of a branded `ManagedRoots`, so every case
 * drives it the way a collector will: spellings in, either a usable root set or
 * a named defect, out.
 *
 * Each test owns its temporary tree and its own `XDG_STATE_HOME`, and reaps both
 * before returning, so nothing here reads or mutates ambient Antonina state.
 * Nothing spawns a process, so there is nothing else to reap.
 */
const withTree = async (build) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'antonina-roots-config-')));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, 'state');
  try {
    return await build(root);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
};

/**
 * A `realpath` seam that records every spelling it was asked about. `resolve`
 * decides what a spelling resolves to, so a case can pose a filesystem fact the
 * host does not actually have (a root resolving to `/`) without inventing one.
 */
function recordingFs(resolve = async (spelling) => spelling) {
  const calls = [];
  return {
    calls,
    fs: {
      realpath: async (spelling) => {
        calls.push(spelling);
        return resolve(spelling);
      },
    },
  };
}

const env = (value) => ({ [MANAGED_ROOTS_ENV]: value });

test('the loader reads exactly one env var name', () => {
  // The drift guard. Two readers of one operator-facing variable that disagree
  // about `resolved` is a collector whose refusals cannot be trusted, and two
  // consumers of two spellings of the same name is how that starts.
  assert.equal(MANAGED_ROOTS_ENV, 'ANTONINA_COLLECT_ROOTS');
});

test('the loader asks about the trimmed, non-empty `:`-separated entries and nothing else', async () => {
  // The parsing is observed through the loader, which is its only public entry
  // point: the `realpath` seam is asked about exactly the spellings the variable
  // names, so this asserts the parse rather than a second exported parser.
  await withTree(async () => {
    const { fs, calls } = recordingFs(async (spelling) => `${spelling}/resolved`);
    const result = await loadManagedRoots(
      {
        ANTONINA_COLLECT_ROOTS: '  /a : : /b :',
        // A differently named variable of the same shape is not read by this
        // loader.
        ANTONINA_MANAGED_ROOTS: '/c',
      },
      MANAGED_ROOTS_ENV,
      fs,
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    // Both entries are trimmed, the empty one is dropped rather than resolved,
    // and the other variable contributed nothing.
    assert.deepEqual(calls, ['/a', '/b']);
    assert.deepEqual(result.roots.roots, [
      { spelled: '/a', resolved: '/a/resolved' },
      { spelled: '/b', resolved: '/b/resolved' },
    ]);
  });
});

test('an unset or empty variable is refused by name, never as "no roots"', async () => {
  await withTree(async () => {
    for (const value of [undefined, '', '  :  : ']) {
      const { fs, calls } = recordingFs();
      const result = await loadManagedRoots(
        value === undefined ? {} : env(value),
        MANAGED_ROOTS_ENV,
        fs,
      );
      assert.equal(result.ok, false, JSON.stringify(value));
      // Distinct from core's `empty`: an operator who never set the variable can
      // act on this, and it never reaches `validateManagedRoots` as a value.
      assert.deepEqual(result.defect, { kind: 'roots-not-configured', variable: MANAGED_ROOTS_ENV });
      assert.equal(result.spelling, null);
      assert.deepEqual(calls, []);
    }
  });
});

test('(a) resolved is this process\'s realpath of spelled, and the seam is called with the spelling', async () => {
  await withTree(async (root) => {
    const target = join(root, 'target');
    const link = join(root, 'link');
    mkdirSync(target);
    symlinkSync(target, link);

    // A seam that delegates to the real filesystem and only records, so this
    // case asserts a real symlinked ancestor and not a simulated one.
    const { fs, calls } = recordingFs((spelling) => realpathCall(spelling));
    const result = await loadManagedRoots(env(link), MANAGED_ROOTS_ENV, fs);

    assert.equal(result.ok, true, JSON.stringify(result));
    // The seam was asked about the spelling, and nothing else: no second
    // argument could smuggle a configured `resolved` coordinate in beside it.
    assert.deepEqual(calls, [link]);
    // A root reached through a symlinked ancestor is stored in both coordinates.
    assert.deepEqual(result.roots.roots, [
      { spelled: link, resolved: target },
    ]);
    // A genuine branded value, produced by core and not rebuilt here. The
    // candidate is located by the root's *spelled* form and judged in its
    // *resolved* coordinates, which is the reason both are stored.
    const judged = evaluateManagedCandidate(result.roots, {
      path: `${link}/project`,
      resolvedPath: `${target}/project`,
      finalComponentIsSymlink: false,
      parentResolvedPath: target,
    });
    assert.equal(judged.eligible, true, JSON.stringify(judged));
  });
});

test('(a) the real filesystem, not the seam, decides `resolved`', async () => {
  await withTree(async (root) => {
    const spelled = join(root, 'plain');
    mkdirSync(spelled);
    const result = await loadManagedRoots(env(spelled), MANAGED_ROOTS_ENV);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.roots.roots, [{ spelled, resolved: spelled }]);
  });
});

test('(a) a spelling and its resolved form naming one directory twice is refused, not merged', async () => {
  await withTree(async (root) => {
    const target = join(root, 'target');
    const link = join(root, 'link');
    mkdirSync(target);
    symlinkSync(target, link);

    const { fs } = recordingFs(async (spelling) => (spelling === link ? target : spelling));
    const result = await loadManagedRoots(env(`${link}:${target}`), MANAGED_ROOTS_ENV, fs);

    assert.equal(result.ok, false, JSON.stringify(result));
    // Core refuses it: the `resolved` coordinates collide even though the
    // spellings do not. A loader that "repaired" the pair would authorise
    // deletions through two names for one directory.
    assert.equal(result.defect.kind, 'duplicate');
    assert.equal(result.defect.path, target);
  });
});

// Title caveat: the "before any I/O" in the title below is scoped to the entry
// under test, and each case here configures exactly one spelling, so no realpath
// call at all is what this test observes. The loader's checks are per-entry
// inside its loop (`managed-roots-config.ts:182-187`): entry N's form defect is
// decided after the entries before it were resolved, so the loader does not
// guarantee that a non-canonical spelling anywhere in a list is refused before
// any I/O. This test does not establish that, and does not claim it.
test('(b) a non-canonical spelling is refused before any I/O', async () => {
  await withTree(async () => {
    const cases = [
      ['relative', 'workspace/project'],
      ['parent-traversal', '/workspace/../etc'],
      ['non-canonical', '/workspace/project/'],
      ['non-canonical', '/workspace//project'],
      ['non-canonical', '/workspace/./project'],
    ];
    for (const [defect, spelling] of cases) {
      const { fs, calls } = recordingFs();
      const result = await loadManagedRoots(env(spelling), MANAGED_ROOTS_ENV, fs);
      assert.equal(result.ok, false, spelling);
      assert.equal(result.defect.kind, 'path-form');
      assert.equal(result.defect.path, spelling);
      assert.equal(result.defect.defect, defect, spelling);
      // The load-bearing half: the form check happens before *this* entry is
      // resolved, so a relative spelling is never resolved against this process's
      // working directory and reported as a path nobody configured. Each case
      // below configures exactly one spelling, so "no realpath call was made" is
      // the whole of the ordering observed here -- see the title caveat above for
      // what this deliberately does not cover.
      assert.deepEqual(calls, [], spelling);
    }
  });
});

test('(b) a later entry\'s form defect is decided after an earlier entry was resolved', async () => {
  await withTree(async (root) => {
    const valid = join(root, 'valid');
    for (const defective of [
      'workspace/project',
      '/workspace/../etc',
      '/workspace/project/',
    ]) {
      const { fs, calls } = recordingFs(async (spelling) => spelling);
      const result = await loadManagedRoots(env(`${valid}:${defective}`), MANAGED_ROOTS_ENV, fs);

      assert.equal(result.ok, false, defective);
      // The refusal names the *later* spelling, not the first configured one,
      // so the operator is told which entry to fix.
      assert.equal(result.defect.kind, 'path-form', defective);
      assert.equal(result.defect.path, defective, defective);
      assert.equal(result.spelling, defective, defective);
      // The load-bearing half. The per-entry rule in the source (`(b)` at
      // `managed-roots-config.ts:130-140`, enforced by the loop at `:182-225`) says
      // entry N is judged before entry N is *resolved*, not before any entry is.
      // Exactly one call, and it is about the earlier entry, is what a per-entry
      // loader does and what a whole-set-before-any-I/O loader would not do; the
      // single-spelling cases above cannot tell the two apart, because they make
      // zero calls either way. This records what the loader does; whether a later
      // defect *should* be reached after earlier I/O is a product question this
      // test does not decide, and the caveats above are not widened by it.
      assert.deepEqual(calls, [valid], defective);
    }
  });
});

test('(c) an unresolvable spelling is refused against that spelling', async () => {
  await withTree(async (root) => {
    const good = join(root, 'good');
    const bad = join(root, 'absent');
    mkdirSync(good);

    const { fs } = recordingFs(async (spelling) => {
      if (spelling === bad) {
        const error = new Error(`ENOENT: no such file or directory, lstat '${spelling}'`);
        error.code = 'ENOENT';
        throw error;
      }
      return spelling;
    });
    const result = await loadManagedRoots(env(`${good}:${bad}:${good}-other`), MANAGED_ROOTS_ENV, fs);

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.defect.kind, 'unresolvable-root');
    assert.equal(result.defect.path, bad);
    assert.equal(result.spelling, bad);
    assert.match(result.defect.message, /ENOENT/);
  });
});

test('(c) a set whose middle entry is unresolvable fails, and never yields the entries around it', async () => {
  await withTree(async (root) => {
    const first = join(root, 'first');
    const middle = join(root, 'middle');
    const last = join(root, 'last');
    mkdirSync(first);
    mkdirSync(last);

    const { fs } = recordingFs(async (spelling) => {
      if (spelling === middle) throw new Error('ENOENT');
      return spelling;
    });
    const result = await loadManagedRoots(env(`${first}:${middle}:${last}`), MANAGED_ROOTS_ENV, fs);

    // A two-root set would leave the collector running with a smaller set than
    // the operator believes, and every later refusal would be reported against a
    // path the operator believes is managed.
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.defect.kind, 'unresolvable-root');
    assert.equal(result.defect.path, middle);
  });
});

// Title caveat: the "before any I/O" in the title below is scoped to the entry
// under test. The first sub-case configures `/` as the only entry, so zero I/O is
// genuinely what it observes. The second puts `/` after a valid root, so an
// earlier entry has already been resolved by the time `/` is reached: the
// spelling check is per-entry inside the loop
// (`managed-roots-config.ts:182-192`), and the source says so at lines 155-157
// ("a later entry whose spelling is `/` is refused after the entries before it
// were resolved"). The loader therefore does not guarantee that `/` anywhere in
// a list is refused before any I/O. This test does not establish that, and does
// not claim it; it records the ordering for the one-entry case only.
test('(d) the spelling `/` is refused before any I/O, though core would accept it', async () => {
  await withTree(async (root) => {
    // Core's own validator accepts a `/` root: `pathFormDefect('/')` is null. The
    // refusal is therefore this loader's, not a delegation.
    assert.equal(validateManagedRoots([{ spelled: '/', resolved: '/' }]).ok, true);

    const { fs, calls } = recordingFs();
    const result = await loadManagedRoots(env('/'), MANAGED_ROOTS_ENV, fs);
    assert.equal(result.ok, false);
    assert.deepEqual(result.defect, { kind: 'root-is-filesystem-root', path: '/' });
    assert.equal(result.spelling, '/');
    assert.deepEqual(calls, []);

    // Among other entries, `/` still decides the outcome: the refusal is not
    // postponed to a whole-set judgement that a later valid entry could dilute.
    // This is about *which* entry decides, not about ordering: the valid entry
    // before `/` is resolved first, so no I/O assertion is made here -- see the
    // title caveat above.
    const withOther = await loadManagedRoots(
      env(`${join(root, 'root')}:/`),
      MANAGED_ROOTS_ENV,
      recordingFs().fs,
    );
    assert.equal(withOther.ok, false);
    assert.equal(withOther.defect.kind, 'root-is-filesystem-root');
  });
});

test('(d) a root that resolves to `/` is refused with its own kind', async () => {
  await withTree(async (root) => {
    const spelled = join(root, 'plausible');
    mkdirSync(spelled);

    // Core accepts this pair too, so the refusal is again the loader's: one
    // symlink hop from a directory that looks entirely reasonable.
    assert.equal(validateManagedRoots([{ spelled, resolved: '/' }]).ok, true);

    const { fs, calls } = recordingFs(async () => '/');
    const result = await loadManagedRoots(env(spelled), MANAGED_ROOTS_ENV, fs);

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.deepEqual(result.defect, {
      kind: 'root-resolves-to-filesystem-root',
      path: spelled,
      resolved: '/',
    });
    assert.equal(result.spelling, spelled);
    // It is refused after the `realpath` that produces the hazard, which is
    // exactly one call for the one spelling.
    assert.deepEqual(calls, [spelled]);
  });
});

test('(a) a `resolved` coordinate is never read from configuration', async () => {
  await withTree(async (root) => {
    const real = join(root, 'real');
    const other = join(root, 'other');
    const link = join(root, 'link');
    mkdirSync(real);
    mkdirSync(other);
    symlinkSync(real, link);

    // The drift guard, and the load-bearing half of (a). Two readers of one
    // operator-facing variable that disagree about `resolved` is a collector
    // whose refusals cannot be trusted, and two consumers of two spellings of the
    // same concept is how that starts -- so the second variable an earlier
    // loader may have read must contribute nothing here, and the only `resolved`
    // value that can appear is the one the seam returns.
    const { fs, calls } = recordingFs(async (spelling) => (spelling === link ? real : spelling));
    const result = await loadManagedRoots(
      { [MANAGED_ROOTS_ENV]: `${link}:${other}`, ANTONINA_COLLECT_ROOTS_RESOLVED: '/etc' },
      MANAGED_ROOTS_ENV,
      fs,
    );

    assert.deepEqual(calls, [link, other]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.roots.roots, [
      { spelled: link, resolved: real },
      { spelled: other, resolved: other },
    ]);
  });
});

test('(e) a nested set hands core\'s defect back, not a re-derived string', async () => {
  await withTree(async (root) => {
    const outer = join(root, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(inner, { recursive: true });

    const result = await loadManagedRoots(env(`${outer}:${inner}`), MANAGED_ROOTS_ENV);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.defect.kind, 'nested');
    assert.equal(result.defect.path, inner);
    assert.equal(result.defect.within, outer);
    assert.equal(result.spelling, inner);

    // The same judgment core reaches, field for field: the loader neither
    // re-derives the kind nor rebuilds the defect.
    const direct = validateManagedRoots([{ spelled: outer, resolved: outer }, { spelled: inner, resolved: inner }]);
    assert.equal(direct.ok, false);
    assert.deepEqual(result.defect, direct.defect);
  });
});

test('(e) a pair that nests only in resolved coordinates is still refused', async () => {
  await withTree(async (root) => {
    // Two spellings side by side, neither inside the other...
    const left = join(root, 'left');
    const right = join(root, 'right');
    mkdirSync(left);
    mkdirSync(right);
    // ...but the second is a symlink whose target is inside the first, so the
    // pair nests once resolved even though the spellings do not. Containment is
    // judged in the resolved coordinate, so the spelled pair looking disjoint is
    // not a defence.
    const nested = join(left, 'nested');
    mkdirSync(nested);
    const link = join(right, 'into-left');
    symlinkSync(nested, link);

    // A seam that delegates to the real filesystem and only records, so this
    // asserts a real symlinked root and not a simulated one.
    const { fs, calls } = recordingFs((spelling) => realpathCall(spelling));
    const result = await loadManagedRoots(env(`${left}:${link}`), MANAGED_ROOTS_ENV, fs);

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.deepEqual(result.defect, { kind: 'nested', path: link, within: left });
    assert.equal(result.spelling, link);
    assert.deepEqual(calls, [left, link]);
  });
});

test('(e) a failed validation never returns a value, so no root set escapes a refusal', async () => {
  await withTree(async (root) => {
    const spelled = join(root, 'root');
    mkdirSync(spelled);
    const { fs } = recordingFs(async () => {
      throw new Error('no');
    });
    for (const [envValue, seam] of [
      [env(spelled), fs],
      [env(`${spelled}:${spelled}`), recordingFs().fs],
      [env('relative'), recordingFs().fs],
    ]) {
      const result = await loadManagedRoots(envValue, MANAGED_ROOTS_ENV, seam);
      assert.equal(result.ok, false);
      assert.equal(result.roots, undefined);
    }
  });
});

test('the success value is core\'s own frozen value, not a rebuild', async () => {
  await withTree(async (root) => {
    const spelled = join(root, 'frozen');
    mkdirSync(spelled);

    const result = await loadManagedRoots(env(spelled), MANAGED_ROOTS_ENV);
    assert.equal(result.ok, true, JSON.stringify(result));
    // Only `validateManagedRoots` can produce these, and it deep-freezes them;
    // a loader that rebuilt the value to add a field would lose both.
    assert.equal(Object.isFrozen(result.roots), true);
    assert.equal(Object.isFrozen(result.roots.roots), true);
    assert.equal(Object.isFrozen(result.roots.roots[0]), true);
  });
});
