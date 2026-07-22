/** Human-friendly "N units ago" formatting for unix timestamps (seconds). */
export function relativeTime(
  unixSeconds: number,
  nowUnixSeconds: number = Date.now() / 1000,
): string {
  const deltaSec = nowUnixSeconds - unixSeconds;
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [seconds, name] of units) {
    const value = Math.floor(deltaSec / seconds);
    if (value >= 1) return `${value} ${name}${value > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}
