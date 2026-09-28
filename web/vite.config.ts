import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

import { buildIdentityPlugin } from './build-identity-plugin.js';

// `define` is deliberately not used for the identity. A `define` is inlined as a
// bare token wherever it is referenced, which makes the provenance unrecoverable
// by anything that does not already know the literal, and it cannot be fetched at
// runtime from a served URL. The plugin writes the identity into two places a
// stranger can actually read: a `version.json` asset and an `antonina:build` meta
// tag in index.html. Board issue 72 owns the `test` block below, which this
// change does not touch.
export default defineConfig({
  base: './',
  plugins: [react(), buildIdentityPlugin()],
  server: {
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  // One environment for the whole web suite, and it is a DOM one. Board issue
  // 72: with `node` here, no `.tsx` test could mount a component, so every
  // assertion was made against an extracted pure helper and a broken import,
  // a bad prop or a render-time throw passed the suite. A split would keep the
  // cheaper default for the pure tests, but the cheaper default is exactly what
  // made the gap invisible: a test that mounts nothing and a test that mounts
  // the app look identical in a test name. `dom-environment.test.tsx` fails if
  // this ever regresses to a non-DOM environment.
  test: { environment: 'jsdom', environmentOptions: { jsdom: { url: 'https://antonina.local/board' } } },
});
