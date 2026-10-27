// Shared local timestamps and relative ages for --version and agent status.
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function displayTimestamp(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function agePhrase(iso: string, now = Date.now()): string {
  let seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const units: Array<[string, number]> = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const parts: string[] = [];
  for (const [name, size] of units) {
    if (parts.length == 2) break;
    const count = Math.floor(seconds / size);
    if (count > 0 || (size === 1 && parts.length === 0)) {
      parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
      seconds -= count * size;
    }
  }
  return `${parts.join(' and ')} ago`;
}


export function agentStatusTimestamp(epochSeconds: number | null, now = Date.now()): string {
  if (epochSeconds === null) return '-';
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return 'invalid timestamp';
  const iso = date.toISOString();
  return `${displayTimestamp(iso)} (${agePhrase(iso, now)})`;
}
