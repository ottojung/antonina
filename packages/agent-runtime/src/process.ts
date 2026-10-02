import { readdirSync, readFileSync } from 'node:fs';
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

export interface ProcessIdentity {
  pid: number;
  startTicks: number;
  agentId: string;
  invocationId?: string;
}

export type SignalSender = (pid: number, signal: NodeJS.Signals | number) => boolean;

export interface ProcessProbeOptions {
  procRoot?: string;
  signal?: SignalSender;
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

/**
 * Signal every process that still carries this exact invocation's environment
 * markers.
 *
 * Managed backends may launch shells or tools in their own process groups. If
 * the backend leader is killed externally (for example by the cgroup OOM
 * killer), those descendants can survive, be reparented to pid 1, and escape
 * the recorded pgid. The agent id alone is intentionally insufficient: an
 * agent can have multiple invocations over its lifetime, while invocation ids
 * are unique to one backend spawn.
 */
export function signalMarkedInvocationProcesses(
  agentId: string,
  invocationId: string,
  signal: NodeJS.Signals | number,
  options: ProcessProbeOptions = {},
): number {
  const procRoot = options.procRoot ?? '/proc';
  const sender = options.signal ?? process.kill;
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return 0;
  }

  let signalled = 0;
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid)) continue;
    if (!envHasAgentMarker(pid, agentId, procRoot)) continue;
    if (!envHasInvocationMarker(pid, invocationId, procRoot)) continue;
    if (trySignal(sender, pid, signal)) signalled += 1;
  }
  return signalled;
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

function trySignal(sender: SignalSender, pid: number, signal: NodeJS.Signals | number): boolean {
  try {
    return sender(pid, signal);
  } catch {
    return false;
  }
}

export function isIdentityAlive(identity: ProcessIdentity, options: ProcessProbeOptions = {}): boolean {
  const procRoot = options.procRoot ?? '/proc';
  const sender = options.signal ?? process.kill;
  if (!identityMatches(identity, procRoot)) return false;
  return trySignal(sender, identity.pid, 0);
}

export function signalIdentityChecked(
  identity: ProcessIdentity,
  signal: NodeJS.Signals | number,
  options: ProcessProbeOptions = {},
): boolean {
  const procRoot = options.procRoot ?? '/proc';
  const sender = options.signal ?? process.kill;
  if (!identityMatches(identity, procRoot)) return false;
  return trySignal(sender, identity.pid, signal);
}

export function signalGroupChecked(
  identity: ProcessIdentity,
  pgid: number,
  signal: NodeJS.Signals | number,
  options: ProcessProbeOptions = {},
): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
  const procRoot = options.procRoot ?? '/proc';
  const sender = options.signal ?? process.kill;
  if (!identityMatches(identity, procRoot)) return false;
  return trySignal(sender, -pgid, signal);
}
