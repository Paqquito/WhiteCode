// Implements: SPEC-OBS-007 (validated, bounded metadata; loaded only by enabled builds).
// Supports: SPEC-BLD-009, E-160.
export function collaborationMetadata(role: string | undefined) {
  const value = role && /^[a-zA-Z0-9_-]+$/.test(role) ? role.slice(0, 64) : undefined;
  return value ? { commonProductAttributes: { orchestrator_role: value }, commonTraceAttributes: { "orchestrator.role": value } } : {};
}
