#!/usr/bin/env node
// Verifies that .github/workflows/web-deploy.yml triggers on every repository
// input the deployed web bundle build can read.
//
// The input graph is re-derived on every run from the build files themselves
// (Makefile -> root package.json scripts -> tsc project configs -> vite entry ->
// TypeScript import graph). Nothing here is a hand-maintained path list, so the
// check cannot drift away from the build the way the original `paths:` filter
// did. Only node: builtins are used; no dependency install is required.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = '.github/workflows/web-deploy.yml';

// `--workflow <file>` reads the workflow from somewhere else while keeping
// `workflowPath` as the logical path that gets traced and compared, so the check
// can be run against a candidate workflow without editing the tracked one. The
// regression test needs exactly that: it removes a `paths` entry and asserts the
// check goes red, which cannot be done by mutating the real workflow.
const workflowOverride = process.argv.indexOf('--workflow');
const readWorkflow = () => readFileSync(
  workflowOverride === -1 ? join(repoRoot, workflowPath) : resolve(process.argv[workflowOverride + 1]),
  'utf8',
);

// --- repository file list -------------------------------------------------

function gitFiles() {
  try {
    // Tracked plus untracked-but-not-ignored, so the check also sees a freshly
    // added build input before it is committed.
    const out = execFileSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return [...new Set(out.split('\0').filter(Boolean))];
  } catch {
    return walk(repoRoot).map((f) => relative(repoRoot, f).split(sep).join('/'));
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = gitFiles();
const fileSet = new Set(files);
const isFile = (f) => fileSet.has(f);
const read = (f) => readFileSync(join(repoRoot, f), 'utf8');
const readJson = (f) => JSON.parse(read(f));

// --- glob matching (git paths-filter style, `**` and `*` only) -----------

function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function globMatches(glob, path) {
  if (!glob.includes('*') && !glob.includes('?') && !glob.includes('[')) {
    return glob === path;
  }
  return globToRegExp(glob).test(path);
}

// `include`/`files` entries are relative to the tsconfig that declares them.
function expandGlob(glob, baseDir) {
  const prefix = baseDir === '.' ? '' : `${baseDir}/`;
  if (glob === '.') return files.filter((f) => f.startsWith(prefix));
  if (glob.endsWith('/**')) return files.filter((f) => f.startsWith(`${prefix}${glob.slice(0, -3)}/`));
  if (glob.endsWith('/**/*')) return files.filter((f) => f.startsWith(`${prefix}${glob.slice(0, -4)}/`));
  if (!glob.includes('*')) {
    // A bare include with no wildcard names one path, and a path is either a file
    // or a directory. The two forms look identical in the include list, so they are
    // told apart by what the repository actually holds at that path: a bare *file*
    // include such as "vite.config.ts" (web/tsconfig.node.json) must match that file
    // itself, and expanding it as a directory prefix would trace nothing at all,
    // shrinking the traced set while the check still reported PASS. A bare
    // *directory* include, "src" in web/tsconfig.json or the packages/*/tsconfig.json
    // projects, keeps matching everything under it. A name that is neither a
    // tracked file nor a directory prefix is treated as a directory, which is the
    // form every current declaration in this repository uses.
    const exact = `${prefix}${glob}`;
    if (isFile(exact)) return files.filter((f) => f === exact);
    return files.filter((f) => f.startsWith(`${exact}/`));
  }
  return files.filter((f) => globMatches(`${prefix}${glob}`, f));
}

// --- workflow trigger extraction -----------------------------------------

function workflowTrigger() {
  const text = readWorkflow();
  const lines = text.split('\n');
  const onIndex = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIndex === -1) throw new Error(`${workflowPath}: no top-level "on:" block found`);
  let i = onIndex + 1;
  let push = null;
  while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i].trim() === '')) {
    const indent = lines[i].match(/^\s*/)[0].length;
    const body = lines[i].trim();
    if (indent === 2 && body === 'push:') {
      const block = [];
      i += 1;
      while (i < lines.length && (/^\s{4,}/.test(lines[i]) || lines[i].trim() === '')) {
        block.push(lines[i]);
        i += 1;
      }
      push = block.join('\n');
      break;
    }
    i += 1;
  }
  if (push === null) return { branches: null, paths: null, deployEveryPush: true };
  const branches = push.match(/branches:\s*\[([^\]]*)\]/);
  const pathsIndex = push.split('\n').findIndex((l) => /^\s+paths:\s*$/.test(l));
  if (pathsIndex === -1) return { branches: branches ? branches[1].trim() : null, paths: null, deployEveryPush: true };
  const paths = [];
  for (const line of push.split('\n').slice(pathsIndex + 1)) {
    const m = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*$/);
    if (!m) break;
    paths.push(m[1]);
  }
  return { branches: branches ? branches[1].trim() : null, paths, deployEveryPush: false };
}

function builderPins(text) {
  const pins = new Set();
  for (const m of text.matchAll(/(ghcr\.io\/ottojung\/skrynia-builder:[^\s"']+)/g)) pins.add(m[1]);
  return [...pins];
}

// --- build graph trace ---------------------------------------------------

const readByBuild = new Set(); // read by `make build` / `npm test --prefix web`
const bundled = new Set(); // can change the emitted web bundle

// kind 'bundle' = can change the emitted browser bundle (must be a trigger input).
// kind 'build'  = read by the deploy build's typecheck gate only (cannot change the bundle).
function mark(file, kind) {
  if (!isFile(file)) return false;
  readByBuild.add(file);
  if (kind === 'bundle') bundled.add(file);
  return true;
}

const ranScripts = new Set();
// `depth` counts *nesting*, so it is decremented on the way out. It used to be
// only ever incremented, which made it a total budget of twelve script
// expansions for the whole run rather than a depth limit, and the difference
// matters because a truncated trace is the green direction: fewer traced inputs,
// fewer uncovered paths, a PASS. Nothing in this repository nests near twelve
// today, so the bug was silent, and a silent truncation is the one failure this
// checker exists to prevent. A tripped limit is now reported for the same
// reason an untraceable specifier is.
const MAX_SCRIPT_DEPTH = 12;
let depth = 0;
let depthLimitTripped = false;

function scriptRunners(manifestFile, scriptNames, kind) {
  const key = `${manifestFile}#${kind}#${[...scriptNames].sort().join(',')}`;
  if (ranScripts.has(key)) return;
  if (depth >= MAX_SCRIPT_DEPTH) {
    depthLimitTripped = true;
    return;
  }
  ranScripts.add(key);
  depth += 1;
  const dir = dirname(manifestFile);
  const manifest = readJson(manifestFile);
  mark(manifestFile, kind);
  const lock = `${dir}/package-lock.json`;
  if (isFile(lock)) mark(lock, kind);
  for (const name of scriptNames) {
    const body = manifest.scripts?.[name];
    if (!body) continue;
    runShell(body, dir, kind);
  }
  depth -= 1;
}

const tsconfigReads = [];

function runShell(command, dir, kind) {
  const prefix = dir === '.' ? '' : `${dir}/`;
  // npm install/ci/run invocations, with or without --prefix
  for (const m of command.matchAll(/npm (ci|install|test|run)\b([^\n;|&]*)/g)) {
    const scoped = m[2].match(/--prefix\s+(\S+)/)?.[1] ?? '.';
    const base = scoped === '.' ? dir : resolve(repoRoot, dir, scoped);
    const manifestFile = relative(repoRoot, join(base, 'package.json')).split(sep).join('/');
    if (m[1] === 'ci' || m[1] === 'install') {
      mark(manifestFile, kind);
      const lock = relative(repoRoot, join(base, 'package-lock.json')).split(sep).join('/');
      if (isFile(lock)) mark(lock, kind);
    } else if (m[1] === 'run') {
      const names = m[2].replace(/--prefix\s+\S+/, '').trim().split(/\s+/).filter(Boolean);
      scriptRunners(manifestFile, names, kind);
    } else {
      scriptRunners(manifestFile, ['test'], kind);
    }
  }
  // tsc project selections: -p <cfg> and -b [cfg]
  for (const m of command.matchAll(/\btsc\b[^\n;|&]*/g)) {
    const args = m[0];
    const project = args.match(/(?:-p|--project)\s+(\S+)/)?.[1];
    const build = args.match(/(?:-b|--build)(?:\s+(\S+))?/)?.[1];
    for (const cfg of [project, build].filter(Boolean)) {
      const file = relative(repoRoot, resolve(repoRoot, dir, cfg)).split(sep).join('/');
      // The web tsc project feeds vite; other projects are only typecheck-gated.
      tsconfigReads.push({ file, kind: file.startsWith('web/') ? 'bundle' : 'build' });
    }
    if (!project && build === undefined) {
      tsconfigReads.push({ file: `${prefix}tsconfig.json`, kind: prefix === 'web/' ? 'bundle' : 'build' });
    }
  }
  // recursive make
  for (const m of command.matchAll(/\bmake\b(?:\s+(\S+))?/g)) {
    if (m[1]) runMake(join(dir, 'Makefile'), m[1], kind);
  }
}

function runMake(makefile, target, kind) {
  if (!isFile(makefile)) return;
  mark(makefile, kind);
  const body = read(makefile);
  const section = body.split(/\n(?=\S)/).find((s) => new RegExp(`^${target}:`).test(s));
  if (!section) return;
  runShell(section.slice(section.indexOf(':') + 1), dirname(makefile), kind);
}

function readTsconfig(file, projectReferences, kind) {
  if (!isFile(file) || !/tsconfig[^/]*\.json$/.test(file)) return;
  mark(file, kind);
  const config = JSON.parse(read(file).replace(/^\s*\/\/.*$/gm, ''));
  for (const ref of config.references ?? []) {
    const target = relative(repoRoot, resolve(repoRoot, dirname(file), ref.path)).split(sep).join('/');
    projectReferences.push({ file: target, kind });
    readTsconfig(target, projectReferences, kind);
  }
  for (const include of config.include ?? []) {
    for (const matched of expandGlob(include, dirname(file))) mark(matched, kind);
  }
  if (config.files) {
    for (const f of config.files) mark(relative(repoRoot, resolve(repoRoot, dirname(file), f)).split(sep).join('/'), kind);
  }
}

function importSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g,
  ];
  for (const p of patterns) for (const m of source.matchAll(p)) specs.add(m[1]);
  return [...specs];
}

const EXTENSIONS = ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.css', '.json'];

// Bare specifiers that this walk could not account for. A relative specifier is
// always resolved, so anything landing here is a specifier the check cannot see
// through: today that is a package inside node_modules, which is correct, but
// the same syntax also names a repository file the moment someone adds a
// tsconfig `paths` alias, a vite `resolve.alias`, or an npm workspace name. The
// skip below cannot tell those apart, and the failure direction is the dangerous
// one: the traced set silently shrinks and the check still reports PASS, which is
// precisely the incident this check exists to prevent. So the two cases are
// separated with a real resolution attempt, and anything still unaccounted for is
// reported by name rather than dropped in silence.
const unresolvedSpecifiers = new Map();

// A specifier is accounted for when the nearest manifest declares it. This
// deliberately reads declarations rather than trying to resolve the module: the
// `trigger-coverage` job runs before any dependency install, so an install-based
// test cannot tell a real package from an alias on a fresh checkout and would
// warn about every third-party import there. A name an alias points at a
// repository file with is not a declared dependency of anything, which is
// exactly the case worth reporting.
const declaredDependencies = new Set();
for (const manifest of files.filter((f) => /(^|\/)package\.json$/.test(f))) {
  let parsed;
  try { parsed = readJson(manifest); } catch { continue; }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(parsed[field] ?? {})) declaredDependencies.add(name);
  }
}

function isDeclaredPackage(spec) {
  const parts = spec.split('/');
  return declaredDependencies.has(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
}

function walkImports(file, kind) {
  if (!isFile(file) || !/\.(ts|tsx|js|jsx|mjs)$/.test(file)) return;
  const source = read(file);
  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith('.')) {
      // A `node:` builtin is named by the platform, never by a repository file
      // and never through an alias, so it is not an input to the filter.
      if (spec.startsWith('node:')) continue;
      if (!isDeclaredPackage(spec)) {
        if (!unresolvedSpecifiers.has(spec)) unresolvedSpecifiers.set(spec, { files: new Set(), bundle: false });
        const entry = unresolvedSpecifiers.get(spec);
        entry.files.add(file);
        if (kind === 'bundle') entry.bundle = true;
      }
      continue;
    }
    const base = relative(repoRoot, resolve(repoRoot, dirname(file), spec)).split(sep).join('/');
    let hit = null;
    for (const ext of EXTENSIONS) {
      const candidate = `${base}${ext}`;
      if (isFile(candidate)) { hit = candidate; break; }
    }
    if (!hit) {
      for (const ext of ['.ts', '.tsx']) {
        const candidate = `${base}/index${ext}`;
        if (isFile(candidate)) { hit = candidate; break; }
      }
    }
    if (!hit) continue;
    mark(hit, kind);
    walkImports(hit, kind);
  }
}

// Entry point: the Makefile target the deploy workflow actually runs. This is
// read out of the `run:` steps and not out of the first `make ` anywhere in the
// file, because a first-match-anywhere read is correct only by ordering: a
// comment, a different step, or an echoed command containing "make " would
// silently redirect the whole trace. That failure direction is green, since a
// wrong target yields a smaller input set, fewer uncovered paths and a PASS.
function makeTargetsInRunSteps(text) {
  const targets = [];
  let openIndent = null;
  for (const line of text.split('\n')) {
    if (openIndent === null) {
      const open = line.match(/^(\s*)run:\s*(.*)$/);
      if (open === null) continue;
      const rest = open[2];
      const isBlock = /^[|>][-+]?\d*\s*$/.test(rest);
      // `run: make build` and `run: | make build` on one line.
      for (const m of rest.replace(/^[|>][-+]?\d*/, '').matchAll(/\bmake (\S+)/g)) targets.push(m[1]);
      if (isBlock) openIndent = open[1].length;
      continue;
    }
    // Inside a `run: |` block: the commands are the more-indented lines until
    // the indentation returns to the key that opened it.
    if (/^\s*$/.test(line)) continue;
    if (line.match(/^\s*/)[0].length <= openIndent) {
      openIndent = null;
      continue;
    }
    for (const m of line.replace(/^\s*#.*$/, '').matchAll(/\bmake (\S+)/g)) targets.push(m[1]);
  }
  return targets;
}

const workflowText = readWorkflow();
const distinctRunTargets = [...new Set(makeTargetsInRunSteps(workflowText))];
if (distinctRunTargets.length > 1) {
  console.error(`  ERROR: the workflow runs more than one make target (${distinctRunTargets.join(', ')});`);
  console.error(`         this check cannot tell which one builds the deployed bundle. Failing rather than guessing.`);
  process.exit(1);
}
const makeTarget = distinctRunTargets[0]
  ?? [...workflowText.matchAll(/\bmake (\S+)/g)][0]?.[1]
  ?? 'build';
if (distinctRunTargets.length === 0) {
  console.log(`  WARNING: no make target was found in any run step; falling back to \`${makeTarget}\`.`);
  console.log(`           A target named only in a comment or outside a run step cannot be traced reliably.`);
}
runMake('Makefile', makeTarget, 'bundle');
scriptRunners('package.json', ['build'], 'bundle');

// The workflow also gates on `npm test --prefix web`; its sources are read by
// the deploy build even though vitest does not emit into the bundle.
for (const m of readWorkflow().matchAll(/npm test --prefix (\S+)/g)) {
  const base = resolve(repoRoot, m[1]);
  for (const cfg of readdirSync(base).filter((f) => /^tsconfig.*\.json$/.test(f))) {
    tsconfigReads.push({ file: `${m[1]}/${cfg}`, kind: 'bundle' });
  }
}

const projectReferences = [];
for (const cfg of tsconfigReads) readTsconfig(cfg.file, projectReferences, cfg.kind);
for (const cfg of projectReferences) readTsconfig(cfg.file, projectReferences, cfg.kind);

// Vite entry: the module script referenced by the web index.html.
const indexHtml = 'web/index.html';
if (isFile(indexHtml)) {
  mark(indexHtml, 'bundle');
  for (const m of read(indexHtml).matchAll(/src="\/([^"]+)"/g)) {
    const entry = `web/${m[1].replace(/^\/+/, '')}`;
    mark(entry, 'bundle');
    walkImports(entry, 'bundle');
  }
}
// Transitive import graph from every source the tsc project configs include.
for (const file of [...bundled]) walkImports(file, 'bundle');
for (const file of [...readByBuild]) walkImports(file, 'build');

// Deployment configuration is itself a trigger input: builder image and the
// deploy action pin both decide what is shipped.
mark(workflowPath, 'bundle');

// --- report --------------------------------------------------------------

const trigger = workflowTrigger();
const required = [...bundled].sort();
const advisory = [...readByBuild].filter((f) => !bundled.has(f)).sort();

console.log(`web-deploy trigger check`);
console.log(`  workflow      : ${workflowPath}`);
console.log(`  push branches : ${trigger.branches ?? '(none)'}`);
console.log(`  paths filter  : ${trigger.paths === null ? '(none - deploys on every matching push)' : trigger.paths.join(', ')}`);
console.log(`  traced bundle inputs: ${required.length}`);

const pins = builderPins(readWorkflow());
if (pins.length) {
  for (const pin of pins) {
    console.log(`  WARNING: builder image pin \`${pin}\` is build input but is not a repository file.`);
    console.log(`           No paths filter can cover a change to it; only a new commit that edits`);
    console.log(`           ${workflowPath} (which is covered) or a manual workflow_dispatch redeploy does.`);
    console.log(`           Mitigation: pin by digest so the tag cannot move silently.`);
  }
}

// Reported for the same reason as the specifier list below, and in the same
// place: a trace that stopped early is a smaller traced set, and a smaller
// traced set is a PASS. Naming it is what keeps the PASS honest.
if (depthLimitTripped) {
  console.log(`  WARNING: the script expansion limit of ${MAX_SCRIPT_DEPTH} nested levels was reached and the trace was`);
  console.log(`           stopped there, so the traced set below is incomplete by construction.`);
  console.log(`           Treat a PASS underneath as unproven, or raise the limit, rather than as coverage.`);
}

// Only bundle-reachable specifiers are reported: a specifier that a file the
// deploy build merely reads cannot change the bundle, so its reachability is
// not a question about trigger coverage.
const untracedBundleSpecifiers = [...unresolvedSpecifiers].filter(([, entry]) => entry.bundle).sort();
if (untracedBundleSpecifiers.length) {
  // Reported before the result line, and named, because a specifier the walk
  // cannot see is an input of unknown reachability. If any of these turns out
  // to name a repository file through a tsconfig `paths` alias, a vite
  // `resolve.alias`, or an npm workspace name, then a real bundle input is
  // missing from the traced set below and the PASS underneath is not evidence of
  // coverage. Treat a PASS as conditional while this list is non-empty.
  for (const [spec, entry] of untracedBundleSpecifiers) {
    console.log(`  WARNING: \`${spec}\` imported by ${[...entry.files].sort().join(', ')} could not be traced.`);
    console.log(`           No manifest in this repository declares it, so it is a repository file reached`);
    console.log(`           through a tsconfig \`paths\` alias, a vite \`resolve.alias\`, or a workspace name,`);
    console.log(`           not a package.`);
    console.log(`           If so, this run's traced set is incomplete and the PASS underneath is not`);
    console.log(`           evidence that the paths filter covers every bundle input. Widen the filter, or`);
    console.log(`           teach this checker the alias, before trusting the result.`);
  }
}

let failed = false;
if (trigger.deployEveryPush) {
  console.log(`  RESULT: PASS (no paths filter: every push to main rebuilds the web bundle)`);
} else {
  const uncovered = required.filter((f) => !trigger.paths.some((p) => globMatches(p, f)));
  for (const file of required) {
    const covering = trigger.paths.filter((p) => globMatches(p, file));
    console.log(`  ${covering.length ? 'covered  ' : 'UNCOVERED'} ${file}${covering.length ? `  (${covering.join(', ')})` : ''}`);
  }
  if (advisory.length) {
    console.log(`  read by the deploy build but cannot change the bundle (not required to be covered):`);
    for (const file of advisory) console.log(`    - ${file}`);
  }
  if (uncovered.length) {
    failed = true;
    console.error(`  RESULT: FAIL - ${uncovered.length} traced build input(s) would not trigger the web deploy:`);
    for (const file of uncovered) console.error(`    - ${file}`);
  } else {
    console.log(`  RESULT: PASS (all ${required.length} traced build inputs are covered)`);
  }
  const stale = trigger.paths.filter((p) => !required.some((f) => globMatches(p, f)));
  for (const pattern of stale) {
    console.log(`  WARNING: paths entry \`${pattern}\` matches no traced build input; every push matching it`);
    console.log(`           costs a deploy cycle. Remove it, or explain why it is kept.`);
  }
}

process.exit(failed ? 1 : 0);
