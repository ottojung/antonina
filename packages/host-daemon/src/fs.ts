import * as nodeFs from 'node:fs';

/**
 * The filesystem surface the daemon uses, injected exactly as `store.ts` injects
 * `StoreFs` and `board-config.ts` injects `BoardConfigFs`.
 *
 * The seam exists so a test can say "this file is missing" and "this file is
 * malformed" as two different things, and so a test never has to reach the
 * operator's real state or config directory to exercise either.
 */
export interface DaemonFs {
  closeSync: typeof nodeFs.closeSync;
  fsyncSync: typeof nodeFs.fsyncSync;
  mkdirSync: typeof nodeFs.mkdirSync;
  openSync: typeof nodeFs.openSync;
  readFileSync: typeof nodeFs.readFileSync;
  renameSync: typeof nodeFs.renameSync;
  unlinkSync: typeof nodeFs.unlinkSync;
  writeFileSync: typeof nodeFs.writeFileSync;
}

export const DEFAULT_DAEMON_FS: DaemonFs = {
  closeSync: nodeFs.closeSync,
  fsyncSync: nodeFs.fsyncSync,
  mkdirSync: nodeFs.mkdirSync,
  openSync: nodeFs.openSync,
  readFileSync: nodeFs.readFileSync,
  renameSync: nodeFs.renameSync,
  unlinkSync: nodeFs.unlinkSync,
  writeFileSync: nodeFs.writeFileSync,
};

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
