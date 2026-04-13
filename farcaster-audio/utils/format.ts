export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.floor(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}
