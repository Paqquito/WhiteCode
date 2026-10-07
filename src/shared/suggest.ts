// Supports: SPEC-MOD-011 (ENF-02), SPEC-MOD-012 (EF-06), SPEC-CAD-002 (ERR-06), SPEC-CFG-001 (ERR-02)
// Edit-distance based "did you mean" suggestions shared by all name lookups.

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Closest candidates within `maxDistance`, best first. */
export function suggest(input: string, candidates: Iterable<string>, maxDistance = 2): string[] {
  const scored: Array<[string, number]> = [];
  const lowered = input.toLowerCase();
  for (const c of candidates) {
    const d = editDistance(lowered, c.toLowerCase());
    if (d <= maxDistance) scored.push([c, d]);
  }
  scored.sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]));
  return scored.map(([c]) => c);
}
