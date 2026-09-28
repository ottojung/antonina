import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { IssueQueue } from './App';
import type { BoardIssue } from './model';

afterEach(cleanup);

// Test safety: this file mounts nothing that reaches the operator's Antonina
// state. The XDG roots are pointed at paths that cannot exist and every issue
// handed to the view is a plain object, so no code under test can read or write
// `$XDG_STATE_HOME`, `trust.json` or `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-dom-env-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-dom-env-config';

/**
 * The regression guard for board issue 72.
 *
 * The defect this file exists to prevent is not a broken component; it is a
 * broken *configuration*: `test.environment` was `node`, and under `node` no
 * `.tsx` test in this suite could mount anything. Every assertion was therefore
 * made against an extracted pure helper, and the suite stayed green through a
 * broken import, a bad prop and a render-time throw. Nothing in the test names
 * made that visible.
 *
 * The guard is deliberately two-sided. The runtime half fails the moment the
 * environment stops being a DOM — a test that only read the config would itself
 * have had to run somewhere, and would have proved nothing about where. The
 * config half names the setting in the file that owns it, so a regression is
 * reported as a regression rather than as a mysterious failure in whichever
 * mounting test happened to run first.
 */
describe('the web suite test environment', () => {
  it('runs with a document, a window and a storage, not in bare node', () => {
    expect(typeof document).toBe('object');
    expect(typeof window).toBe('object');
    expect(typeof window.localStorage).toBe('object');
    // A storage that cannot be written is not a storage; a board page keeps the
    // reader's display name and its trust anchor here, so this is the specific
    // capability the board app needs from its environment.
    window.localStorage.setItem('antonina:dom-environment-probe', 'present');
    expect(window.localStorage.getItem('antonina:dom-environment-probe')).toBe('present');
    window.localStorage.removeItem('antonina:dom-environment-probe');
    expect(document.createElement('div')).toBeInstanceOf(HTMLElement);
  });

  it('mounts a component into the document, so an unmounted test cannot pass as a mounted one', () => {
    // The whole point of the move: a real component tree, attached to a real
    // document, driven by the same render path the browser uses. `IssueQueue`
    // is used here because it needs no session and no provider — the guard tests
    // the environment, not the app.
    const issue: BoardIssue = { number: 1, title: 'Probe issue', body: '', state: 'open', createdAt: '2026-09-27T09:00:00.000Z', updatedAt: '2026-09-27T09:00:00.000Z', messages: [] };
    const { container } = render(<IssueQueue issues={[issue]} queue={[]} hasWriteAccess={false} selectedNumber={undefined} onSelect={() => {}} onReorder={async () => null} empty={{ title: 'none', body: 'none' }} />);

    expect(container.isConnected).toBe(true);
    expect(document.body.contains(container)).toBe(true);
    expect(container.querySelector('[data-issue="1"]')).not.toBeNull();
    expect(container.textContent).toContain('Probe issue');
  });

  it('is configured as a DOM environment and not as node', () => {
    const config = readFileSync(resolve(import.meta.dirname, '../vite.config.ts'), 'utf8');

    // The environment is named in the file that sets it, so a regression to
    // `node` is caught by name here even if some future environment were to
    // provide a `document` and no layout.
    expect(config).toMatch(/environment: '(jsdom|happy-dom)'/);
    expect(config).not.toMatch(/environment: 'node'/);
  });
});
