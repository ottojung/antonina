import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AgentMetadata } from './metadata.js';
import { persistedAgentId, procStartTicks } from './process.js';

const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 400;

export interface StatePathsOptions {
  env?: Record<string, string | undefined>;
  home?: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function stateRoot(options: StatePathsOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const base = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return join(base, 'antonina');
}

export function agentsDir(options: StatePathsOptions = {}): string {
  return join(stateRoot(options), 'agents');
}

export function agentDir(agentId: string, options: StatePathsOptions = {}): string {
  return join(agentsDir(options), agentId);
}

export function metaPath(agentId: string, options: StatePathsOptions = {}): string {
  return join(agentDir(agentId, options), 'meta.json');
}

export function logPath(agentId: string, options: StatePathsOptions = {}): string {
  return join(agentDir(agentId, options), 'output.log');
}

export function readMeta(agentId: string, options: StatePathsOptions = {}): AgentMetadata | null {
  if (persistedAgentId(agentId) !== agentId) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(metaPath(agentId, options), 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const meta = value as AgentMetadata;
    return persistedAgentId(meta.id) === agentId ? meta : null;
  } catch {
    return null;
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeMeta(agentId: string, meta: AgentMetadata, options: StatePathsOptions = {}): void {
  if (persistedAgentId(agentId) !== agentId || persistedAgentId(meta.id) !== agentId) {
    throw new Error('managed-agent metadata id is malformed or mismatched');
  }
  const destination = metaPath(agentId, options);
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.meta-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, destination);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

interface LockOwner {
  pid: number;
  startTicks: number | null;
}

function parseLockOwner(path: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) return null;
    if (record.startTicks !== null && (typeof record.startTicks !== 'number' || !Number.isSafeInteger(record.startTicks) || record.startTicks < 0)) return null;
    return { pid: record.pid, startTicks: record.startTicks as number | null };
  } catch {
    return null;
  }
}

function lockOwnerAlive(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch {
    return false;
  }
  if (owner.startTicks === null) return true;
  return procStartTicks(owner.pid) === owner.startTicks;
}

async function acquireLock(path: string): Promise<number> {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const owner: LockOwner = { pid: process.pid, startTicks: procStartTicks(process.pid) };
      writeFileSync(fd, JSON.stringify(owner), 'utf8');
      fsyncSync(fd);
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const owner = parseLockOwner(path);
      if (owner === null || !lockOwnerAlive(owner)) {
        try {
          unlinkSync(path);
          continue;
        } catch {}
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(`timed out acquiring Antonina metadata lock: ${path}`);
}

export async function withAgentLock<T>(
  agentId: string,
  fn: () => Promise<T> | T,
  options: StatePathsOptions = {},
): Promise<T> {
  const directory = agentDir(agentId, options);
  if (!existsSync(directory)) throw new Error(`unknown agent: ${agentId}`);
  const path = join(directory, '.lock');
  const fd = await acquireLock(path);
  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(path); } catch {}
  }
}

export async function updateMeta(
  agentId: string,
  mutate: (meta: AgentMetadata) => void,
  options: StatePathsOptions = {},
): Promise<AgentMetadata | null> {
  return withAgentLock(agentId, () => {
    const meta = readMeta(agentId, options);
    if (meta === null) return null;
    mutate(meta);
    writeMeta(agentId, meta, options);
    return meta;
  }, options);
}

export function createAgentDirectory(agentId: string, options: StatePathsOptions = {}): boolean {
  mkdirSync(agentsDir(options), { recursive: true });
  const directory = agentDir(agentId, options);
  try {
    mkdirSync(directory);
    syncDirectory(dirname(directory));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export function removeAgentDirectory(agentId: string, options: StatePathsOptions = {}): void {
  rmSync(agentDir(agentId, options), { recursive: true, force: true });
  syncDirectory(agentsDir(options));
}
