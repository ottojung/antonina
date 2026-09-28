
import { renderToStaticMarkup } from 'react-dom/server';
import { type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

// Test safety: nothing here may read or mutate the operator's Antonina state.
// Every target in this file is a plain object handed to the view, and the XDG
// roots are pointed at paths that cannot exist, so no code under test can reach
// the real `$XDG_STATE_HOME` or the real `trust.json` / `credential.json`.
process.env.XDG_STATE_HOME = '/nonexistent-antonina-web-targets-state';
process.env.XDG_CONFIG_HOME = '/nonexistent-antonina-web-targets-config';

import { TargetsView } from './App';
import type { DaemonHostView, HostBytesMeasurement, TargetView } from './api';
import { EXECUTION_TARGET_GUIDANCE, executionTargetAccess, formatHostBytes } from './api';
import { formatBytesMeasurement, targetStateLines, TARGET_PERSISTENCE_LABEL } from './targets';

// This suite runs in a node environment: no document, no layout engine, no
// `App`. What is provable here is that `TargetsView` renders what it is handed
// — the descriptive metadata of a persistent host and of an ephemeral provider
// side by side, the live capacity when a daemon report is supplied, and an
// explicit `unknown` or `not applicable` with a reason when it is not. What is
// not proved is anything about the tab, the nav, or the shell: `App` is never
// mounted, which is the gap board issue 72 tracks.
const STAMP = '2026-09-27T09:00:00.000Z';

function bytes(value: number, source: string): HostBytesMeasurement {
  return { ok: true, bytes: value, source };
}

function missing(reason: 'not-configured' | 'unreadable' | 'malformed' | 'unsupported', detail: string): HostBytesMeasurement {
  return { ok: false, reason, detail };
}

const gib = 1024 ** 3;

function persistentTarget(overrides: Partial<TargetView> = {}): TargetView {
  return {
    id: 'phoebe-dev',
    backend: 'lubko',
    kind: 'persistent-host',
    status: 'available',
    capabilities: ['network-egress', 'persistent-filesystem'],
    address: 'lubko://phoebe-dev',
    description: 'persistent Lubko workstation',
    displayName: 'Phoebe (Lubko)',
    createdAt: STAMP,
    updatedAt: STAMP,
    resources: [],
    dispatchedIssues: [],
    ...overrides,
  };
}

function ephemeralTarget(overrides: Partial<TargetView> = {}): TargetView {
  return {
    id: 'ci-runner',
    backend: 'github-actions',
    kind: 'ephemeral-environment',
    status: 'available',
    capabilities: ['ephemeral-lifetime', 'network-egress'],
    address: null,
    description: 'GitHub Actions workflow environments',
    createdAt: STAMP,
    updatedAt: STAMP,
    resources: [],
    dispatchedIssues: [],
    ...overrides,
  };
}

/** A daemon-backed persistent host, related to the catalog by the address it reports. */
function daemonHost(overrides: Partial<DaemonHostView> = {}): DaemonHostView {
  return {
    hostId: 'phoebe-dev',
    address: 'lubko://phoebe-dev',
    targetId: 'phoebe-dev',
    liveness: { status: 'online', ageMs: 4_000, reason: 'published inside the stale threshold' },
    health: 'healthy',
    observedAt: STAMP,
    heartbeatCount: 12,
    telemetry: {
      uptimeSeconds: 86_400,
      memory: { total: bytes(32 * gib, 'os.totalmem'), available: bytes(9 * gib, 'os.freemem') },
      filesystems: [{
        path: '/workspace',
        total: bytes(512 * gib, 'statfs'),
        available: bytes(214 * gib, 'statfs'),
      }],
      cpu: { logicalCores: 16, model: 'Test CPU', loadAverage: [0.4, 0.5, 0.6] as const },
      problems: [],
    },
    ...overrides,
  };
}

function markup(targets: TargetView[], hosts: DaemonHostView[] = []): string {
  return renderToStaticMarkup(<TargetsView targets={targets} hosts={hosts} onOpenIssue={() => {}} />);
}

describe('the execution target overview', () => {
  it('shows the descriptive metadata of a persistent host, not just its name', () => {
    const page = markup([persistentTarget()]);
    expect(page).toContain('Phoebe (Lubko)');
    expect(page).toContain('phoebe-dev · lubko://phoebe-dev');
    expect(page).toContain('Persistent host');
    expect(page).toContain('Lubko transport');
    expect(page).toContain('Durable — the filesystem survives the job');
    expect(page).toContain('Host-local collector available; it collects by hand, with --confirm');
    expect(page).toContain('network-egress, persistent-filesystem');
  });

  it('points at the guidance document for each backend instead of repeating the procedure', () => {
    const page = markup([persistentTarget(), ephemeralTarget()]);
    expect(page).toContain(EXECUTION_TARGET_GUIDANCE.lubko);
    expect(page).toContain(EXECUTION_TARGET_GUIDANCE['github-actions']);
  });

  it('renders the live capacity of a daemon-backed persistent host', () => {
    // This case proves the *view*, not the shipped app. `App.tsx` hands
    // `TargetsView` `hosts={[]}` on purpose, because a browser cannot read a
    // host's daemon report, so the shipped page states `unknown` for every
    // persistent host. Nothing here is evidence that the board page shows
    // capacity; it is the rendering a caller with host reports would get, and
    // the reason `target list --telemetry` exists.
    const page = markup([persistentTarget()], [daemonHost()]);
    expect(page).toContain('phoebe-dev · online');
    expect(page).toContain('9.0 GiB free of 32.0 GiB');
    expect(page).toContain('214.0 GiB free of 512.0 GiB');
    expect(page).toContain('16 logical cores');
    expect(page).toContain('0.4 / 0.5 / 0.6');
    expect(page).toContain('not applicable');
  });

  it('explains an absent value and leaves a reported one unexcused', () => {
    // An online host has a real liveness value, so the reason it is online is
    // not rendered under it: a muted explanation belongs to a value that is
    // missing, and a host that is present is not a mystery.
    const online = markup([persistentTarget()], [daemonHost()]);
    expect(online).toContain('phoebe-dev · online');
    expect(online).not.toContain('published inside the stale threshold');
    // What is true of a reported value — when it was seen — is still shown.
    expect(online).toContain('last report at');

    // An offline host is the case the reason is for, and it is still shown.
    const offline = markup([persistentTarget()], [daemonHost({
      liveness: { status: 'offline', ageMs: 900_000, reason: 'the last report is past the stale threshold' },
    })]);
    expect(offline).toContain('phoebe-dev · offline');
    expect(offline).toContain('the last report is past the stale threshold');
  });

  it('states unknown capacity for a persistent host that reported nothing, and never a zero', () => {
    const page = markup([persistentTarget()]);
    expect(page).toContain('unknown');
    expect(page).toContain('No host-local daemon report reached this page');
    expect(page).not.toContain('0 B');
    expect(page).not.toMatch(/free of 0/);
  });

  it('keeps each absent measurement as its own unknown rather than a missing row', () => {
    const host = daemonHost({
      telemetry: {
        uptimeSeconds: null,
        memory: { total: bytes(32 * gib, 'os.totalmem'), available: missing('unsupported', 'the platform does not expose free memory') },
        filesystems: [{ path: '/workspace', total: bytes(512 * gib, 'statfs'), available: missing('unreadable', 'statfs failed') }],
        cpu: { logicalCores: null, model: null, loadAverage: null },
        problems: ['/workspace could not be stated'],
      },
    });
    const page = markup([persistentTarget()], [host]);
    expect(page).toContain('unknown (unsupported)');
    expect(page).toContain('unknown (unreadable)');
    expect(page).toContain('unknown (cores not reported)');
    expect(page).toContain('unknown (not reported on this platform)');
    expect(page).toContain('/workspace could not be stated');
  });

  it('reports an offline host as offline, which is not the same as a silent one', () => {
    const offline = daemonHost({
      liveness: { status: 'offline', ageMs: 900_000, reason: 'the last report is past the stale threshold' },
      health: null,
      telemetry: null,
    });
    const page = markup([persistentTarget()], [offline]);
    expect(page).toContain('phoebe-dev · offline');
    expect(page).toContain('The last report carried no telemetry.');
  });

  it('never draws host telemetry for an ephemeral provider, and says why', () => {
    const page = markup([ephemeralTarget()]);
    expect(page).toContain('not applicable');
    expect(page).toContain('An ephemeral environment has no host RAM, disk or CPU of its own');
    expect(page).toContain('unknown');
    expect(page).toContain('Antonina holds no integration that reads a provider account quota');
    // A host-shaped figure would be a number nobody measured.
    expect(page).not.toMatch(/GiB/);
    expect(page).not.toMatch(/logical cores/);
    expect(page).not.toContain('Lubko transport');
    // And it is shown as persisting nothing between jobs.
    expect(page).toContain(TARGET_PERSISTENCE_LABEL['per-job-workspace']);
    expect(page).toContain('The provider expires it; Antonina has no part in it');
  });

  it('refuses a host report for a target the catalog does not relate to it', () => {
    // A report whose address no target claims must not be attached to the
    // nearest target, so the page still states that it knows nothing.
    const page = markup([persistentTarget()], [daemonHost({ targetId: null, address: null })]);
    expect(page).toContain('No host-local daemon report reached this page');
  });

  it('shows a target recorded unavailable as unavailable rather than routing around it', () => {
    const page = markup([ephemeralTarget({ status: 'unavailable' })]);
    expect(page).toContain('Unavailable — refused by name, not routed around');
  });

  it('states the caveats a target registers about itself', () => {
    const page = markup([ephemeralTarget({
      limitations: ['a job may not be split across two dispatches here', 'workflow runs are visible only in the provider'],
    })]);
    expect(page).toContain('a job may not be split across two dispatches here');
    expect(page).toContain('workflow runs are visible only in the provider');
  });

  it('says the catalog is empty rather than showing an empty page', () => {
    const page = markup([]);
    expect(page).toContain('No execution targets registered');
    expect(page).toContain('antonina board target add');
  });

  it('keeps a target identity separate from its display name', () => {
    // The name is what a reader sees; the id is what a job and a dispatch record
    // name, so both have to be on the card.
    // The card carries the id as a machine-readable attribute as well as text,
    // which is what a test or a later view can hang a link on.
    const page = markup([persistentTarget()]);
    expect(page).toContain('data-target-id="phoebe-dev"');
    expect(page).toContain('Phoebe (Lubko)');
  });

  it('reads a target that registers no display name as its own id', () => {
    const access = executionTargetAccess(persistentTarget({ displayName: undefined }));
    expect(access.displayName).toBe('phoebe-dev');
    expect(markup([persistentTarget({ displayName: undefined })])).toContain('phoebe-dev');
  });

  it('relates each target to the host view by the relation the board derives', () => {
    const lines = targetStateLines(persistentTarget(), [daemonHost({ targetId: 'phoebe-dev' })]);
    expect(lines.map((line) => line.label)).toContain('Memory');
    const unrelated = targetStateLines(persistentTarget(), [daemonHost({ targetId: null, address: 'lubko://other' })]);
    expect(unrelated.every((line) => line.absent)).toBe(true);
  });

  it('formats an absent measurement as its reason and a present one as bytes', () => {
    expect(formatBytesMeasurement(missing('not-configured', 'no workspace path was configured')))
      .toBe('unknown (not-configured)');
    // The byte scale itself is core vocabulary, not web formatting, so the page
    // and the CLI cannot print the same number two different ways.
    expect(formatHostBytes(gib)).toBe('1.0 GiB');
    expect(formatHostBytes(0)).toBe('0 B');
  });
});
