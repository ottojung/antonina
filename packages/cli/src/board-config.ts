import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  parseBoardCredential,
  parseBoardTrustAnchor,
  type BoardCredential,
} from '../../core/src/credential.js';
import type { BoardTrustAnchor } from '../../core/src/operations.js';
import { AntoninaApiError } from '../../core/src/api.js';

/**
 * The Antonina configuration directory, resolved the way every other XDG
 * consumer resolves it: `$XDG_CONFIG_HOME/antonina`, falling back to
 * `$HOME/.config/antonina` when that variable is unset or empty.
 *
 * This is the *config* root and is deliberately a different tree from the
 * managed-session state root in `packages/agent-runtime/src/store.ts` (which
 * resolves `$XDG_STATE_HOME/antonina`). Credentials are configuration an
 * operator places once and expects every fresh shell to pick up; they are not
 * runtime state, and they must not be swept away by a `clean`.
 */
export const BOARD_TRUST_FILE = 'trust.json';
export const BOARD_CREDENTIAL_FILE = 'credential.json';

/**
 * The filesystem surface this loader needs, injected exactly as
 * `store.ts` injects `StoreFs` and `managed-roots-config.ts` injects `RootsFs`:
 * the seam is what makes "a file that is not there" and "a file that is
 * malformed" two distinguishable, testable outcomes rather than one swallowed
 * `undefined`.
 */
export interface BoardConfigFs {
  readFileSync: typeof readFileSync;
}

const DEFAULT_FS: BoardConfigFs = { readFileSync };

export interface BoardConfigOptions {
  env: Record<string, string | undefined>;
  /** Injected for test isolation; defaults to the process home directory. */
  home?: string;
  fs?: BoardConfigFs;
}

/**
 * One configured file's contents, or the reason it is not configured.
 *
 * `absent` is not an error. A board is readable with only a trust anchor and
 * writable with only a credential, and a shell that has neither file yet is
 * the normal state of a fresh installation, so an absent file contributes
 * nothing rather than refusing the whole command. A file that *is* there and
 * cannot be understood is a different situation: the operator placed it and it
 * is wrong, so it is reported by path instead of being skipped.
 */
export type BoardConfigEntry<T> =
  | { readonly found: true; readonly path: string; readonly value: T }
  | { readonly found: false; readonly path: string };

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Reads one JSON configuration file, or reports that it is not there.
 *
 * The parse failure names the path, not an abstract configuration error, so a
 * half-written or wrongly-shaped file is a one-line fix for the operator who
 * wrote it. `parse` is the caller's schema check, so "not JSON" and "not a
 * board credential" both surface against the same path.
 */
function readBoardConfigFile<T>(
  path: string,
  parse: (value: unknown) => T,
  fs: BoardConfigFs,
): BoardConfigEntry<T> {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { found: false, path };
    throw new AntoninaApiError('could not read ' + path, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new AntoninaApiError(path + ' must contain valid JSON', { cause: error });
  }
  try {
    return { found: true, path, value: parse(value) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AntoninaApiError(path + ': ' + message, { cause: error });
  }
}

export interface BoardConfigFiles {
  trust: BoardConfigEntry<BoardTrustAnchor>;
  credential: BoardConfigEntry<BoardCredential>;
}

/** An absent file is an unconfigured value, not a `null` the API has to know about. */
export function configuredValue<T>(entry: BoardConfigEntry<T>): T | null {
  return entry.found ? entry.value : null;
}

/** The resolved `$XDG_CONFIG_HOME/antonina` (or `$HOME/.config/antonina`). */
export function boardConfigDir(options: BoardConfigOptions): string {
  const home = options.home ?? options.env.HOME ?? homedir();
  const base = options.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'antonina');
}

/**
 * The trust anchor and credential a normal `antonina board` command runs with.
 *
 * These two files are the only source. There is no environment override: a
 * credential is a long-lived secret, and a value that can arrive two different
 * ways is a value whose provenance an operator can no longer state. One source
 * also means a fresh shell needs nothing exported -- open a terminal and the
 * board works.
 */
export function loadBoardConfigFiles(options: BoardConfigOptions): BoardConfigFiles {
  const fs = options.fs ?? DEFAULT_FS;
  const dir = boardConfigDir(options);
  return {
    trust: readBoardConfigFile(join(dir, BOARD_TRUST_FILE), parseBoardTrustAnchor, fs),
    credential: readBoardConfigFile(join(dir, BOARD_CREDENTIAL_FILE), parseBoardCredential, fs),
  };
}
