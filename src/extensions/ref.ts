// Supports: SPEC-EXT-002 (`<name>@<catalogue>` references), SPEC-EXT-007 (§ 5.1)

/** `<name>@<catalogue>`, or a bare name. */
export function parseRef(ref: string): { name: string; catalog?: string } {
  const at = ref.lastIndexOf("@");
  return at > 0 ? { name: ref.slice(0, at), catalog: ref.slice(at + 1) } : { name: ref };
}
