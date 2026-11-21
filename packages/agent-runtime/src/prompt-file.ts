import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** One prompt may be large, but never unbounded: 8 MiB admits 250 KiB work. */
export const MAX_PROMPT_BYTES = 8 * 1024 * 1024;

function decode(bytes: Buffer, source: string): string {
  if (bytes.length === 0) throw new Error(`${source} prompt is empty`);
  if (bytes.length > MAX_PROMPT_BYTES) throw new Error(`${source} prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${source} prompt is not valid UTF-8`);
  return text;
}

/** Read a caller-supplied prompt file. No content is ever put in argv or env. */
export function readPromptFile(path: string): string {
  if (!isAbsolute(path)) throw new Error('prompt file path must be absolute');
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('prompt file must be a regular file, not a symlink or directory');
    }
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('prompt file must be a regular file, not a symlink or directory');
    if (info.uid !== (process.getuid?.() ?? info.uid)) throw new Error('prompt file must be owned by the current user');
    if ((info.mode & 0o077) !== 0) throw new Error('prompt file must not be group- or world-accessible');
    if (info.size > MAX_PROMPT_BYTES) throw new Error('prompt file exceeds maximum bytes');
    return decode(readFileSync(fd), 'prompt file');
  } finally {
    closeSync(fd);
  }
}

/** Read a prompt from stdin with the same bounds and UTF-8 rules as a file. */
export function readPromptStdin(fd = 0): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const block = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const count = readSync(fd, block, 0, block.length, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_PROMPT_BYTES) throw new Error('stdin prompt exceeds maximum bytes');
    chunks.push(Buffer.from(block.subarray(0, count)));
  }
  return decode(Buffer.concat(chunks), 'stdin');
}
