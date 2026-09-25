import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STAT_MIN_FIELDS = 20;
const STAT_STATE_FIELD_INDEX = 0;
const STAT_PPID_FIELD_INDEX = 1;
const STAT_PGRP_FIELD_INDEX = 2;
const STAT_UTIME_FIELD_INDEX = 11;
const STAT_STIME_FIELD_INDEX = 12;
const STAT_STARTTIME_FIELD_INDEX = 19;

export const INVOCATION_ID_HEX_LENGTH = 32;
const HEX = /^[0-9a-f]+$/;
const HEX_CASE_INSENSITIVE = /^[0-9a-f]+$/i;

export interface ProcStat {
  state: string;
  ppid: number;
  pgrp: number;
  userTicks: number;
  systemTicks: number;
  startTicks: number;
}

export interface PidfdOps {
  open(pid: number): number | null;
  send(pidfd: number, signal: number): boolean;
  close(pidfd: number): void;
}

export const unavailablePidfdOps: PidfdOps = {
  open: () => null,
  send: () => false,
  close: () => undefined,
};

export interface ProcessIdentity {
  pid: number;
  startTicks: number;
  agentId: string;
  invocationId?: string;
}

export interface ProcessProbeOptions {
  procRoot?: string;
  pidfd?: PidfdOps;
}

function parseStrictInteger(raw: string): number | null {
  if (!/^-?[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function splitProcStatFields(stat: string): string[] | null {
  const closeParen = stat.lastIndexOf(')');
  if (closeParen < 0) return null;
  const suffix = stat.slice(closeParen + 1).trim();
  if (!suffix) return null;
  const fields = suffix.split(/\s+/);
  return fields.length >= STAT_MIN_FIELDS ? fields : null;
}

export function parseProcStat(stat: string): ProcStat | null {
  const fields = splitProcStatFields(stat);
  if (!fields) return null;
  const state = fields[STAT_STATE_FIELD_INDEX];
  const ppidRaw = fields[STAT_PPID_FIELD_INDEX];
  const pgrpRaw = fields[STAT_PGRP_FIELD_INDEX];
  const userRaw = fields[STAT_UTIME_FIELD_INDEX];
  const systemRaw = fields[STAT_STIME_FIELD_INDEX];
  const startRaw = fields[STAT_STARTTIME_FIELD_INDEX];
  if (!state || state.length !== 1 || !ppidRaw || !pgrpRaw || !userRaw || !systemRaw || !startRaw) return null;
  const ppid = parseStrictInteger(ppidRaw);
  const pgrp = parseStrictInteger(pgrpRaw);
  const userTicks = parseStrictInteger(userRaw);
  const systemTicks = parseStrictInteger(systemRaw);
  const startTicks = parseStrictInteger(startRaw);
  if (ppid === null || pgrp === null || userTicks === null || systemTicks === null || startTicks === null) return null;
  return { state, ppid, pgrp, userTicks, systemTicks, startTicks };
}

export function readProcStat(pid: number, procRoot = '/proc'): ProcStat | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    return parseProcStat(readFileSync(join(procRoot, String(pid), 'stat'), 'utf8'));
  } catch {
    return null;
  }
}

export function procStartTicks(pid: number, procRoot = '/proc'): number | null {
  return readProcStat(pid, procRoot)?.startTicks ?? null;
}

export function processStateChar(pid: number, procRoot = '/proc'): string | null {
  return readProcStat(pid, procRoot)?.state ?? null;
}

export function processIsZombie(pid: number, procRoot = '/proc'): boolean {
  const state = processStateChar(pid, procRoot);
  return state === null || state === 'Z' || state === 'X';
}

export function processPpid(pid: number, procRoot = '/proc'): number | null {
  return readProcStat(pid, procRoot)?.ppid ?? null;
}

export function processPgrp(pid: number, procRoot = '/proc'): number | null {
  const stat = readProcStat(pid, procRoot);
  if (!stat || stat.state === 'Z' || stat.state === 'X') return null;
  return stat.pgrp;
}

export function procCpuTicks(pid: number, procRoot = '/proc'): number | null {
  const stat = readProcStat(pid, procRoot);
  return stat ? stat.userTicks + stat.systemTicks : null;
}

export function envHasEntry(pid: number, entry: string, procRoot = '/proc'): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || entry.length === 0 || entry.includes('\0')) return false;
  try {
    const environ = readFileSync(join(procRoot, String(pid), 'environ'));
    return environ.toString('latin1').split('\0').includes(entry);
  } catch {
    return false;
  }
}

export function envHasAgentMarker(pid: number, agentId: string, procRoot = '/proc'): boolean {
  return envHasEntry(pid, `ANTONINA_AGENT_ID=${agentId}`, procRoot);
}

export function envHasInvocationMarker(pid: number, invocationId: string, procRoot = '/proc'): boolean {
  return envHasEntry(pid, `ANTONINA_INVOCATION_ID=${invocationId}`, procRoot);
}

export function normalizeAgentId(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = raw.trim().toLowerCase();
  return value.length > 0 && HEX.test(value) ? value : null;
}

export function persistedAgentId(raw: unknown): string | null {
  return typeof raw === 'string' && normalizeAgentId(raw) === raw ? raw : null;
}

export function persistedInvocationId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length === INVOCATION_ID_HEX_LENGTH && HEX_CASE_INSENSITIVE.test(raw)
    ? raw
    : null;
}

export function persistedProcessInteger(raw: unknown, minimum: number): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= minimum ? raw : null;
}

function identityMatches(identity: ProcessIdentity, procRoot: string): boolean {
  if (procStartTicks(identity.pid, procRoot) !== identity.startTicks) return false;
  if (!envHasAgentMarker(identity.pid, identity.agentId, procRoot)) return false;
  return identity.invocationId === undefined || envHasInvocationMarker(identity.pid, identity.invocationId, procRoot);
}

export function isIdentityAlive(identity: ProcessIdentity, options: ProcessProbeOptions = {}): boolean {
  const procRoot = options.procRoot ?? '/proc';
  const pidfd = options.pidfd ?? unavailablePidfdOps;
  const fd = pidfd.open(identity.pid);
  if (fd === null) return false;
  try {
    return identityMatches(identity, procRoot) && pidfd.send(fd, 0);
  } finally {
    pidfd.close(fd);
  }
}

export function signalIdentityChecked(
  identity: ProcessIdentity,
  signal: number,
  options: ProcessProbeOptions = {},
): boolean {
  const procRoot = options.procRoot ?? '/proc';
  const pidfd = options.pidfd ?? unavailablePidfdOps;
  const fd = pidfd.open(identity.pid);
  if (fd === null) return false;
  try {
    if (!identityMatches(identity, procRoot)) return false;
    return pidfd.send(fd, signal);
  } finally {
    pidfd.close(fd);
  }
}
