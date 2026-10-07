// Implements: SPEC-MOD-002 (§ 7.3 exit codes, EF-04)

export const ExitCode = {
  Success: 0,
  ExecutionError: 1,
  UsageOrConfiguration: 2,
  Limit: 3,
  BlockedByPolicy: 4,
  ConsentRequired: 5,
  Partial: 6,
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
