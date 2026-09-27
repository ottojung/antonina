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
    // bare directory include, e.g. "src"
    return files.filter((f) => f.startsWith(`${prefix}${glob}/`));
  }
  return files.filter((f) => globMatches(`${prefix}${glob}`, f));
}

// --- workflow trigger extraction -----------------------------------------

function workflowTrigger() {
  const text = read(workflowPath);
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
let depth = 0;

function scriptRunners(manifestFile, scriptNames, kind) {
  const key = `${manifestFile}#${kind}#${[...scriptNames].sort().join(',')}`;
  if (ranScripts.has(key) || depth > 12) return;
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

function walkImports(file, kind) {
  if (!isFile(file) || !/\.(ts|tsx|js|jsx|mjs)$/.test(file)) return;
  const source = read(file);
  for (const spec of importSpecifiers(source)) {
    if (!spec.startsWith('.')) continue; // bare specifiers resolve inside node_modules
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

// Entry point: the Makefile target the deploy workflow invokes.
const makeTarget = read(workflowPath).match(/make (\S+)/)?.[1] ?? 'build';
runMake('Makefile', makeTarget, 'bundle');
scriptRunners('package.json', ['build'], 'bundle');

// The workflow also gates on `npm test --prefix web`; its sources are read by
// the deploy build even though vitest does not emit into the bundle.
for (const m of read(workflowPath).matchAll(/npm test --prefix (\S+)/g)) {
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

const pins = builderPins(read(workflowPath));
if (pins.length) {
  for (const pin of pins) {
    console.log(`  WARNING: builder image pin \`${pin}\` is build input but is not a repository file.`);
    console.log(`           No paths filter can cover a change to it; only a new commit that edits`);
    console.log(`           ${workflowPath} (which is covered) or a manual workflow_dispatch redeploy does.`);
    console.log(`           Mitigation: pin by digest so the tag cannot move silently.`);
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
