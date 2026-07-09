// Simple sliding-window rate limiter for alert delivery.
let timestamps: number[] = [];

export function allowAlert(maxPerMinute: number): boolean {
  const now = Date.now();
  timestamps = timestamps.filter((t) => now - t < 60_000);
  if (timestamps.length >= maxPerMinute) return false;
  timestamps.push(now);
  return true;
}
