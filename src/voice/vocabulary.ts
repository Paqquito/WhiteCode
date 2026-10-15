// Implements: SPEC-VOX-003 (bounded vocabulary from names only, project terms first).
import { containsSecret } from "../shared/secrets";
const GENERAL = [
  "function",
  "variable",
  "class",
  "interface",
  "module",
  "import",
  "export",
  "branch",
  "commit",
  "repository",
  "request",
  "response",
  "database",
  "query",
  "server",
  "client",
  "component",
  "TypeScript",
  "JavaScript",
  "Python",
  "JSON",
  "HTTP",
  "test",
  "error",
  "build",
];
export function speechVocabulary(options: {
  files: readonly string[];
  project: string;
  branches: readonly string[];
  extra: readonly string[];
}): string[] {
  const result = new Set<string>();
  for (const value of [
    options.project,
    ...options.files.slice(0, 2000),
    ...options.branches.slice(0, 100),
    ...options.extra.slice(0, 100),
    ...GENERAL,
  ]) {
    if (value.length > 4096 || containsSecret(value)) continue;
    const words = value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
      .split(/[^\p{L}\p{N}]+/u);
    for (const word of words) {
      const normalized = word.toLowerCase();
      if (
        normalized.length >= 3 &&
        normalized.length <= 40 &&
        !/^\d+$/.test(normalized) &&
        !containsSecret(normalized)
      )
        result.add(normalized);
      if (result.size >= 256) return [...result];
    }
  }
  return [...result];
}
