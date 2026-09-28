// Emits the build identity into the web deployment's output.
//
// The web bundle is served from a namespace, not from a checkout, so once it is
// deployed the only thing that survives is what the build wrote. This plugin
// writes two such places:
//
//   - `version.json`, a static asset next to the bundle, so an operator can
//     read the exact source revision of what is live with one unauthenticated
//     `curl` and hand it straight to a rollback;
//   - an `antonina:build` meta tag in index.html, so the running page reports
//     its own identity for a diagnostics screenshot without a second request.
//
// The CLI equivalent is `antonina --version`. Both read the same generated
// module, so a CLI and a web UI built from one tree cannot disagree about which
// revision they are.

import type { Plugin } from 'vite';

import {
  WEB_BUILD_IDENTITY,
  WEB_BUILD_PROVENANCE,
  type WebBuildProvenance,
} from './build-identity.generated.js';

export const PROVENANCE_ASSET_FILE = 'version.json';
export const BUILD_META_NAME = 'antonina:build';

/** The `antonina:build` value: one token, safe to read off a screenshot. */
export function buildMetaContent(identity: WebBuildProvenance): string {
  return `${identity.version}+${identity.shortCommit}${identity.dirty ? '-dirty' : ''}`;
}

/** `version.json` body, byte-stable for a given identity. */
export function provenanceJson(identity: WebBuildProvenance): string {
  return `${JSON.stringify(identity, null, 2)}\n`;
}

/**
 * The meta tag, formatted to match the existing index.html style (two-space
 * indent, self-closing void element).
 */
export function buildMetaTag(identity: WebBuildProvenance): string {
  return `    <meta name="${BUILD_META_NAME}" content="${buildMetaContent(identity)}" />`;
}

/**
 * Checks the generated identity is usable and throws if it is not.
 *
 * The generator refuses to emit an unusable identity, so reaching this branch
 * means the generated module was hand-edited, truncated, or produced by a
 * different tool than the one this repository ships. Failing the build is the
 * correct outcome: a bundle that claims an identity nobody can verify is the
 * false assurance this mechanism exists to remove, and it is worse than no
 * identity at all because it looks like an answer.
 */
export function assertUsableIdentity(identity: WebBuildProvenance): void {
  const problems: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(identity.commit)) {
    problems.push(`commit is not a 40-character object name: ${JSON.stringify(identity.commit)}`);
  }
  if (!identity.shortCommit || !identity.commit.startsWith(identity.shortCommit)) {
    problems.push(`shortCommit ${JSON.stringify(identity.shortCommit)} is not a prefix of the commit`);
  }
  if (!/^\d+\.\d+\.\d+/.test(identity.version)) {
    problems.push(`version is not a semantic version: ${JSON.stringify(identity.version)}`);
  }
  if (problems.length > 0) {
    throw new Error(
      'web build identity is unusable, refusing to build a bundle that cannot be traced to a'
        + ` revision: ${problems.join('; ')}. Regenerate it with \`npm run generate:build-identity\`.`,
    );
  }
}

export function buildIdentityPlugin(identity: WebBuildProvenance = WEB_BUILD_PROVENANCE): Plugin {
  return {
    name: 'antonina-build-identity',
    // `pre` so a bad identity fails before the bundle is transformed, rather
    // than after minutes of work.
    enforce: 'pre',
    buildStart() {
      assertUsableIdentity(identity);
    },
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: { name: BUILD_META_NAME, content: buildMetaContent(identity) },
        injectTo: 'head-prepend',
      }];
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: PROVENANCE_ASSET_FILE,
        source: provenanceJson(identity),
      });
    },
  };
}

// Re-exported so a test can assert against the identity this bundle was built
// with without reaching into the generated module's path.
export { WEB_BUILD_IDENTITY };
