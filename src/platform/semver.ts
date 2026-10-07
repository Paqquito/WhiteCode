// Supports: SPEC-EXT-008 (§ 5.3 semantic order, ranges), SPEC-EXT-007 (constraints)
// Runtime adapter: semantic versions and ranges.

/** True when `version` satisfies the range (`^1.2`, `>=3.0`, `1.x`, `a || b`…). */
export function satisfies(version: string, range: string): boolean {
  try {
    return Bun.semver.satisfies(version, range);
  } catch {
    return false;
  }
}

/** Semantic order: negative when `a` comes before `b` (a pre-release comes before its final version). */
export function compareVersions(a: string, b: string): number {
  return Bun.semver.order(a, b);
}
