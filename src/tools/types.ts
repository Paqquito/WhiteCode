// Implements: SPEC-OUT-001 (§ 5.1 tool contract, EF-01, EF-06 normalised errors, RG-01, RG-02)
// Supports: SPEC-PER-018 (private consent state write invariant), gap E-138.

import type { TaskList } from "../engine/task-list";
import type { BackgroundTasks } from "../engine/background";
import type { WebAccess } from "./fetch-url";
import type { ContentPart } from "../providers/types";
import type { ProtectedLocations } from "../permissions/paths";
import type { PlatformName } from "../platform/system";
import type { PosixShell, PowerShellInfo, ShellRuntime } from "./shell-runtime";

export interface ToolFlags {
  readonly readOnly: boolean;
  readonly concurrencySafe: boolean;
  readonly destructive: boolean;
  readonly requiresPermission: boolean;
  readonly openWorld: boolean;
}

/** What a permission rule is matched against (SPEC-PER-002 § 5.2). */
export type RuleSubject =
  | { readonly kind: "paths"; readonly access: "read" | "write"; readonly paths: readonly string[] }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "url"; readonly url: string }
  /** A named element, such as a skill (`use_skill(<name>)`). */
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "none" };

export interface ToolSettings {
  readonly readDefaultLines: number;
  readonly readMaxLineLength: number;
  readonly readMaxBytesWithoutRange: number;
  readonly readPdfMaxPages: number;
  readonly resultInlineLimit: number;
  readonly writeMaxSize: number;
  readonly editLenientMatching: boolean;
  readonly findMaxResults: number;
  readonly findTimeoutMs: number;
  readonly respectIgnoreFiles: boolean;
  readonly searchDefaultLimit: number;
  readonly searchMaxLineLength: number;
  readonly searchTimeoutMs: number;
}

export interface ReadRecord {
  readonly mtimeMs: number;
  readonly size: number;
  /** True when the whole file was read without truncation (SPEC-OUT-003 RG-02). */
  readonly complete: boolean;
}

export interface ToolEnvironment {
  readonly platform: PlatformName;
  readonly home: string;
  /** Shells detected for this session (SPEC-OUT-008 EF-01, SPEC-OUT-009 § 5.3 point 1); absent: no shell tool. */
  readonly shells?: { readonly posix?: PosixShell; readonly powershell?: PowerShellInfo };
}

export interface ToolContext extends ToolEnvironment {
  readonly cwd: string;
  readonly allowedDirectories: readonly string[];
  readonly signal: AbortSignal;
  readonly settings: ToolSettings;
  readonly readState: Map<string, ReadRecord>;
  /** Locations whose writing always requires a request (SPEC-PER-010 EF-02). */
  readonly protectedLocations: ProtectedLocations;
  /** True when a `deny` rule forbids reading this path (RG-01 of SPEC-OUT-006 and SPEC-OUT-007). */
  readonly readDenied: (path: string) => boolean;
  /** Product-owned state cannot be modified by model-facing file tools, even after automatic approval. */
  readonly writeDenied?: (path: string) => boolean;
  /** The model accepts images (catalogue capability `images`). */
  readonly modelImages: boolean;
  /** Folders readable without request besides the allowed ones: large results of the session (SPEC-PER-010 FA-01). */
  readonly extraReadableDirectories?: readonly string[];
  /** Shell state of the session (working folder, snapshot, processes). */
  readonly shell?: ShellRuntime;
  /** Search engine of the system (ripgrep); undefined forces the built-in fallback (SPEC-OUT-007 FA-02). */
  readonly ripgrepPath?: string;
  /** Task list of the context (SPEC-OUT-020), and the agent the tools act for (default: the main agent). */
  readonly taskList?: TaskList;
  readonly agentName?: string;
  /** Background tasks of the session (SPEC-AGT-016). */
  readonly background?: BackgroundTasks;
  /** Reading web pages (SPEC-OUT-012). */
  readonly web?: WebAccess;
}

/** Difference shown with an approval request (SPEC-OUT-003 EF-06), or an early refusal found before asking. */
/** The difference shown before a decision (SPEC-OUT-003 EF-06), with the change it describes (SPEC-IHM-005). */
export type ToolPreview = { readonly diff: string; readonly change?: FileChange } | { readonly refusal: ToolOutcome };

export type ToolErrorKind = "invalid_input" | "permission_denied" | "unavailable" | "timeout" | "execution" | "interrupted" | "not_executed";

export interface ToolOutcome {
  readonly isError: boolean;
  readonly errorKind?: ToolErrorKind;
  readonly content: readonly ContentPart[];
}

export interface Tool<I = Record<string, unknown>> {
  readonly name: string;
  /** Name under which the rules decide its calls, when it is not its own (`monitor_process` is decided as `run_shell`). */
  readonly permissionName?: string;
  readonly inputSchema: Record<string, unknown>;
  /** Description for the model, from the text referential (stable within a session, EF-08). */
  description(env: ToolEnvironment): string;
  flags(input: I): ToolFlags;
  isEnabled(env: ToolEnvironment): boolean;
  /** Business validation beyond the schema; returns an error message for the model. */
  validate?(input: I, ctx: ToolContext): string | undefined;
  ruleSubject(input: I, ctx: ToolContext): RuleSubject;
  /** Tool-specific contribution to the permission decision (SPEC-PER-001 step 5). */
  permissionContribution?(input: I, ctx: ToolContext): "allow" | "ask" | undefined;
  /** Why the call is dangerous, if it is: the dialog then proposes « Non » by default (SPEC-IHM-027 CA-02). */
  danger?(input: I): string | undefined;
  /** Own time limit of a call (SPEC-MOT-002 EF-05), bounded by `engine.toolTimeout`. */
  timeoutMs?(input: I, ctx: ToolContext): number;
  /** Computed before the permission decision: the difference to show, or a refusal that makes asking pointless. */
  preview?(input: I, ctx: ToolContext): Promise<ToolPreview>;
  execute(input: I, ctx: ToolContext): Promise<ToolOutcome>;
  summary(input: I): string;
}

import type { FileChange } from "../shared/diff";

export function textOutcome(text: string, isError = false, errorKind?: ToolErrorKind): ToolOutcome {
  return { isError, errorKind: isError ? (errorKind ?? "execution") : undefined, content: [{ type: "text", text }] };
}
