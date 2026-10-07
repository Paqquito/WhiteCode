// Supports: SPEC-EXT-019 (§ 5.1 header of a skill)
// Runtime adapter: YAML reading (the header of a skill or a command file).

/** Parses YAML text; throws on invalid YAML. */
export function parseYaml(text: string): unknown {
  return Bun.YAML.parse(text);
}
