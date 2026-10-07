// Supports: SPEC-PER-001 (§ 5.3 point c fingerprint of a hook declaration), SPEC-PER-019 (RG-01 fingerprint of a connector declaration)
// Fingerprint of a declaration as written: any change of its content gives another one, whatever the order of the keys.

import { createHash } from "node:crypto";

/** JSON with sorted keys. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** `sha256:` followed by the hexadecimal digest of the canonical JSON of `value`. */
export function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
