// Implements: SPEC-INT-006 (§ 5 lifecycle), SPEC-OUT-040 (§ 5 read-only navigation).
// Supports: SPEC-OUT-003/004 (diagnostics after successful writes), gap E-143.
import type { PlatformName } from "../platform/system";
import type { ReminderProducer } from "../engine/reminders";

export interface LanguageAccess {
  readonly cwd: string;
  readonly allowedDirectories: readonly string[];
  readonly platform: PlatformName;
  readonly readDenied: (path: string) => boolean;
  readonly signal?: AbortSignal;
  readonly agentName?: string;
}
export const LANGUAGE_OPERATIONS = ["go_to_definition", "go_to_implementation", "find_references", "hover", "document_symbols", "workspace_symbols", "incoming_calls", "outgoing_calls"] as const;
export type LanguageOperation = (typeof LANGUAGE_OPERATIONS)[number];
export interface LanguageQuery {
  readonly operation: LanguageOperation;
  readonly file_path?: string;
  readonly line?: number;
  readonly character?: number;
  readonly query?: string;
}
export interface LanguageService {
  /** Starts lazily; a read must never wait for initialization. */
  opened(path: string, text: string, access: LanguageAccess): void;
  changed(path: string, text: string, access: LanguageAccess): Promise<string[]>;
  query(input: LanguageQuery, access: LanguageAccess): Promise<string>;
  reminders(access: () => LanguageAccess): ReminderProducer;
  status(): readonly { name: string; state: string }[];
  close(): Promise<void>;
}
