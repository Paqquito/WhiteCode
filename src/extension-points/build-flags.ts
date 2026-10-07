// Implements: SPEC-BLD-002 (EF-01 compile-time constants, EF-02 unknown name rejected at compile time, EF-04 single registry)
// Registry of build options (SPEC-CAD-003 § 4). The build replaces reads by constants; all options are off in lot 1.

export const BUILD_FLAGS = {
  permission_auto_approve: false,
  permission_auto_approve_powershell: false,
  shell_classifier: false,
  shell_syntax_analysis: false,
  compaction_on_overflow: false,
  context_token_target: false,
  memory_auto_extraction: false,
  agent_forked: false,
  stream_compact_profile: false,
  system_instructions_export: false,
} as const;

export type BuildFlagName = keyof typeof BUILD_FLAGS;

/** Reads a build option. Only literal names of the registry type-check (EF-02). */
export function buildFlag(name: BuildFlagName): boolean {
  return BUILD_FLAGS[name];
}
