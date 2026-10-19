// Implements: SPEC-MOT-029 (CA-01/02, isolated writes, deferred approvals and conflict detection).
// Supports: SPEC-PER-001 (unchanged decisions), SPEC-SES-006 (backup only on acceptance).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { securePrivateDirectory } from "../platform/private-file";
import { isWithin } from "../platform/system";
import { isProtectedPath, realTargetPath } from "../permissions/paths";
import { NEUTRAL_HOOKS } from "../extension-points/hooks";
import { restrictedView } from "../tools/registry";
import type { Tool, ToolContext, ToolOutcome, ToolPreview } from "../tools/types";
import { decodeText, readStateKey, recordWrite, writeAtomic } from "../tools/text-file";
import type { ContentPart, ToolCall } from "../providers/types";
import type { RecordType } from "../session/transcript";
import type { EngineEvent, TurnResult } from "./events";
import { Conversation } from "./conversation";
import { runTurn, type LoopDeps } from "./loop";

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);
const MAX_FILE = 8 * 1024 * 1024, MAX_LAYER = 32 * 1024 * 1024, MAX_BUFFER = 4 * 1024 * 1024;
type Entry = { path: string; target: string; shadow: string; before?: Buffer; stamp: string; written: boolean; size: number };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function speculationPrompt(value: string | readonly ContentPart[]): string | undefined { return typeof value === "string" ? value : value.length === 1 && value[0]?.type === "text" ? value[0].text : undefined; }
function stamp(path: string): string {
  if (!existsSync(path)) return "absent:" + realTargetPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE) throw Error("Unsupported speculative target");
  return [realTargetPath(path), stat.dev, stat.ino, stat.mode, stat.mtimeMs, digest(readFileSync(path))].join(":");
}
const contextKey = (deps: LoopDeps, key: string) => JSON.stringify({ key, model: deps.model, system: deps.conversation.system, tools: deps.conversation.tools, history: deps.conversation.messages, permission: deps.executor.permissionContext() });

/** Only one draft owns an overlay. No model-facing tool can address its private paths. */
export class SpeculativeTurn {
  readonly conversation: Conversation;
  readonly controller = new AbortController();
  readonly entries = new Map<string, Entry>();
  readonly originalKey: string;
  readonly result: Promise<TurnResult | undefined>;
  readonly counters = { accepted: 0, discarded: 0, modelCost: 0, unknownCost: false };
  #state: "draft" | "promoting" | "accepted" | "discarded" = "draft";
  #root?: string;
  #bytes = 0;
  #bufferBytes = 0;
  #events: EngineEvent[] = [];
  #records: Array<{ type: RecordType; data: Record<string, unknown>; id: string }> = [];
  #effects: Array<() => void> = [];
  #ids = new Map<string, string>();
  #readState: ToolContext["readState"] = new Map();
  #active = new Set<Promise<unknown>>();
  #gateResolve!: (accepted: boolean) => void;
  #gate = new Promise<boolean>(resolve => { this.#gateResolve = resolve; });
  #deadline: ReturnType<typeof setTimeout>;
  #current: LoopDeps;
  #requests = 0;
  constructor(readonly prompt: string, readonly deps: LoopDeps, readonly options: { tempDir: string; key: string; valid: () => boolean; signal: AbortSignal }) {
    this.#current = deps;
    this.originalKey = contextKey(deps, options.key);
    this.conversation = new Conversation(deps.conversation.system, deps.conversation.tools);
    this.conversation.restore(structuredClone(deps.conversation.messages));
    this.#deadline = setTimeout(() => this.discard(), 120000);
    const abort = () => this.discard();
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) this.discard();
    const replaced = new Map<string, Tool<never>>();
    for (const tool of deps.executor.registry.list()) replaced.set(tool.name, this.#tool(tool));
    const hooks = { ...NEUTRAL_HOOKS, beforeTool: async (call: ToolCall) => {
      if (!FILE_TOOLS.has(call.name)) await this.#wait(this.controller.signal);
      return this.#state === "accepted" ? this.#current.hooks.beforeTool(call) : {};
    }, afterTool: async (call: ToolCall, error: boolean, output?: string) => this.#state === "accepted" ? this.#current.hooks.afterTool(call, error, output) : {},
    turnCompleted: async (text: string) => this.#state === "accepted" ? this.#current.hooks.turnCompleted(text) : {},
    turnFailed: async (reason: string) => { if (this.#state === "accepted") await this.#current.hooks.turnFailed(reason); } };
    const owner = this;
    const draft: LoopDeps = { ...deps, conversationId: (deps.conversationId ?? "") + ":speculation:" + randomUUID(), conversation: this.conversation, hooks, context: undefined, reminders: undefined, pendingNote: undefined, takeQueued: undefined,
      fallback: undefined, projectHistory: undefined, onUserMessage: undefined, takeSubmittedResult: undefined,
      postSampling: assistant => { const effect = () => this.#current.postSampling?.(assistant); if (this.#state === "accepted") effect(); else this.#effects.push(effect); },
      afterToolResults: (calls, results) => { const effect = () => this.#current.afterToolResults?.(calls, results); if (this.#state === "accepted") effect(); else this.#effects.push(effect); },
      transcript: { append: (type, data) => {
        if (this.#state === "accepted") return this.#append(type, data);
        this.#bound(data); const id = "speculative-" + this.#records.length; this.#records.push({ type, data, id }); return id;
      }, flush: () => { if (this.#state === "accepted") this.#current.transcript?.flush(); } },
      beforeRequest: async signal => {
        if (this.#state === "draft" && (++this.#requests > 4 || !options.valid())) { this.discard(); throw Error("Speculation unavailable"); }
        if (this.#state === "accepted") await this.#current.beforeRequest?.(signal);
        else if (deps.executor.policyRefusal?.()) throw Error("Speculation blocked by policy");
      },
      emit: event => {
        if (event.type === "usage") { if (event.cost === undefined) this.counters.unknownCost = true; else this.counters.modelCost += event.cost; deps.emit(event); return; }
        if (this.#state === "accepted") this.#emit(event);
        else if (this.#state === "draft" || this.#state === "promoting") { this.#bound(event); this.#events.push(event); }
      },
      executor: { ...deps.executor, hooks, registry: restrictedView(deps.executor.registry, () => true, replaced),
        beforePermissionResolution: async signal => { if (this.#state !== "accepted") await this.#wait(signal); },
        prepareDescriptiveRules: async (query, context, signal) => { if (this.#state === "accepted") await this.#current.executor.prepareDescriptiveRules?.(query, context, signal); },
        fileHistory: { beforeWrite: paths => this.#state === "accepted" ? this.#current.executor.fileHistory?.beforeWrite(paths) : undefined,
          afterWrite: paths => { if (this.#state === "accepted") this.#current.executor.fileHistory?.afterWrite(paths); } },
        recordExecution: (call, outcome, difference, change) => { const effect = () => this.#current.executor.recordExecution?.(call, outcome, difference, change); if (this.#state === "accepted") effect(); else this.#effects.push(effect); },
        persistRule: (scope, rule) => { if (this.#state === "accepted") this.#current.executor.persistRule?.(scope, rule); },
        permissionQueue: { run: (signal, action) => this.#state === "accepted" && this.#current.executor.permissionQueue ? this.#current.executor.permissionQueue.run(signal, action) : action(signal),
          expired: signal => this.#state === "accepted" && (this.#current.executor.permissionQueue?.expired?.(signal) ?? false) },
        loopGuard: undefined, largeResults: undefined,
        toolContext: signal => ({ ...this.#current.executor.toolContext(signal), readState: this.#state === "accepted" ? this.#current.executor.toolContext(signal).readState : new Map(deps.executor.toolContext(signal).readState) }),
        get authorities() { return owner.#current.executor.authorities; },
      },
    };
    this.result = runTurn(draft, prompt, this.controller.signal).then(result => {
      if (result.cost.confirmed === undefined) this.counters.unknownCost = true;
      if (result.stopCause !== "completed" && this.#state !== "accepted") { this.discard(); return undefined; }
      return result;
    }, error => { if (this.#state === "accepted") throw error; this.counters.unknownCost = true; this.discard(); return undefined; }).finally(() => options.signal.removeEventListener("abort", abort));
  }
  #bound(value: unknown): void { this.#bufferBytes += Buffer.byteLength(JSON.stringify(value)); if (this.#bufferBytes > MAX_BUFFER) { this.discard(); throw Error("Speculation buffer limit"); } }
  async #wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let release!: () => void;
    const aborted = new Promise<false>(resolve => { release = () => resolve(false); signal.addEventListener("abort", release, { once: true }); });
    try { if (!await Promise.race([this.#gate, aborted])) throw Error("Speculation discarded"); signal.throwIfAborted(); }
    finally { signal.removeEventListener("abort", release); }
  }
  #entry(path: string, ctx: ToolContext): Entry | undefined {
    const target = realTargetPath(path), cwd = realTargetPath(ctx.cwd);
    if (!isWithin(path, cwd, ctx.platform) || !isWithin(target, cwd, ctx.platform) || isProtectedPath(path, ctx.protectedLocations, ctx.platform) || ctx.readDenied(path) || ctx.writeDenied?.(path)) return undefined;
    const key = readStateKey(path, ctx.platform), previous = this.entries.get(key); if (previous) return previous;
    let before: Buffer | undefined, originalStamp: string;
    try { originalStamp = stamp(path); before = existsSync(path) ? readFileSync(path) : undefined; } catch { return undefined; }
    // Native document/image readers may upload or launch helpers: they wait for acceptance.
    if (before && (!decodeText(before) || [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extname(path).toLowerCase()))) return undefined;
    if (this.entries.size >= 64 || this.#bytes + (before?.length ?? 0) > MAX_LAYER) return undefined;
    if (!this.#root) { mkdirSync(this.options.tempDir, { recursive: true }); this.#root = mkdtempSync(join(this.options.tempDir, "speculation-")); securePrivateDirectory(this.#root); }
    const shadow = join(this.#root, String(this.entries.size) + extname(path));
    if (before) writeAtomic(shadow, before, ctx.platform, true);
    const entry = { path, target, shadow, before, stamp: originalStamp, written: false, size: before?.length ?? 0 };
    this.#bytes += before?.length ?? 0; this.entries.set(key, entry);
    const read = ctx.readState.get(key);
    if (read && before) { const original = statSync(path), copy = statSync(shadow); if (original.mtimeMs === read.mtimeMs && original.size === read.size) this.#readState.set(readStateKey(shadow, ctx.platform), { ...read, mtimeMs: copy.mtimeMs, size: copy.size }); }
    return entry;
  }
  #mapped(input: never, entry: Entry): never { return { ...(input as object), path: entry.shadow } as never; }
  #context(ctx: ToolContext): ToolContext { return { ...ctx, readState: this.#readState, languages: undefined, shell: undefined, background: undefined, taskList: undefined, web: undefined, readDenied: () => false, writeDenied: undefined }; }
  #restore<T>(value: T, entry: Entry): T { return JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(entry.shadow).slice(1, -1), JSON.stringify(entry.path).slice(1, -1))) as T; }
  #tool(tool: Tool<never>): Tool<never> {
    return { ...tool,
      preview: tool.preview ? async (input, ctx): Promise<ToolPreview> => {
        if (this.#state !== "draft") { await this.#wait(ctx.signal); return tool.preview!(input, this.#current.executor.toolContext(ctx.signal)); }
        const path = (input as { path?: unknown })?.path;
        const entry = FILE_TOOLS.has(tool.name) && typeof path === "string" ? this.#entry(path, ctx) : undefined;
        if (!entry) { await this.#wait(ctx.signal); return tool.preview!(input, this.#current.executor.toolContext(ctx.signal)); }
        return this.#restore(await tool.preview!(this.#mapped(input, entry), this.#context(ctx)), entry);
      } : undefined,
      execute: async (input, ctx): Promise<ToolOutcome> => {
        const path = (input as { path?: unknown })?.path;
        const entry = this.#state === "draft" && FILE_TOOLS.has(tool.name) && typeof path === "string" ? this.#entry(path, ctx) : undefined;
        if (!entry) { await this.#wait(ctx.signal); return tool.execute(input, this.#current.executor.toolContext(ctx.signal)); }
        const action = tool.execute(this.#mapped(input, entry), this.#context(ctx)); this.#active.add(action);
        try {
          const outcome = await action;
          if (!outcome.isError && tool.name !== "read_file") {
            entry.written = true; const size = statSync(entry.shadow).size; this.#bytes += size - entry.size; entry.size = size;
            if (size > MAX_FILE || this.#bytes > MAX_LAYER) { this.discard(); throw Error("Speculation file limit"); }
          }
          return this.#restore(outcome, entry);
        } finally { this.#active.delete(action); }
      },
    };
  }
  #append(type: RecordType, data: Record<string, unknown>): string {
    const id = this.#current.transcript?.append(type, data) ?? "";
    if (type === "user" && !data["synthetic"]) this.#current.onUserMessage?.(id || undefined);
    return id;
  }
  #emit(event: EngineEvent): void {
    this.#current.emit(event.type === "user_message" && event.recordId ? { ...event, recordId: this.#ids.get(event.recordId) || undefined } : event);
  }
  async accept(prompt: string | readonly ContentPart[], deps: LoopDeps, key: string, signal: AbortSignal): Promise<TurnResult | undefined> {
    if (speculationPrompt(prompt) !== this.prompt || this.#state !== "draft" || !this.options.valid() || contextKey(deps, key) !== this.originalKey) { this.discard(); return undefined; }
    this.#state = "promoting"; await Promise.allSettled([...this.#active]);
    if (signal.aborted || this.#state !== "promoting") { this.discard(); return undefined; }
    try { if ([...this.entries.values()].some(entry => stamp(entry.path) !== entry.stamp)) { this.discard(); return undefined; } }
    catch { this.discard(); return undefined; }
    const changed = [...this.entries.values()].filter(entry => entry.written);
    // Checkpoint the accepted user message before creating its ordinary file-history backups.
    this.#current = deps;
    const first = this.#records[0];
    if (first?.type === "user") { this.#ids.set(first.id, this.#append(first.type, first.data)); this.#records.shift(); }
    const refusal = changed.length ? deps.executor.fileHistory?.beforeWrite(changed.map(entry => entry.path)) : undefined;
    if (refusal) { this.discard(); throw Error(refusal); }
    const applied: Entry[] = [];
    try {
      for (const entry of changed) { writeAtomic(entry.path, readFileSync(entry.shadow), deps.executor.toolContext(signal).platform); applied.push(entry); }
    } catch (error) {
      for (const entry of applied.reverse()) { if (entry.before) writeAtomic(entry.path, entry.before, deps.executor.toolContext(signal).platform); else rmSync(entry.path, { force: true }); }
      this.discard(); throw error;
    }
    clearTimeout(this.#deadline); this.#state = "accepted"; this.counters.accepted++;
    for (const entry of this.entries.values()) if (existsSync(entry.path)) {
      const ctx = deps.executor.toolContext(signal), read = this.#readState.get(readStateKey(entry.shadow, ctx.platform));
      if (entry.written) recordWrite(entry.path, ctx);
      else if (read) { const stat = statSync(entry.path); ctx.readState.set(readStateKey(entry.path, ctx.platform), { ...read, mtimeMs: stat.mtimeMs, size: stat.size }); }
    }
    deps.executor.fileHistory?.afterWrite(changed.map(entry => entry.path));
    for (const record of this.#records) this.#ids.set(record.id, this.#append(record.type, record.data));
    for (const event of this.#events) this.#emit(event);
    for (const effect of this.#effects) effect();
    this.#records = []; this.#events = []; this.#effects = []; this.#gateResolve(true);
    const abort = () => this.controller.abort(); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { const result = await this.result; deps.conversation.branch(this.conversation.messages); deps.transcript?.flush(); return result; }
    finally { signal.removeEventListener("abort", abort); this.#cleanup(); }
  }
  discard(): void { if (this.#state === "accepted" || this.#state === "discarded") return; this.#state = "discarded"; this.counters.discarded++; clearTimeout(this.#deadline); this.controller.abort(); this.#gateResolve(false); this.#records = []; this.#events = []; this.#effects = []; void Promise.allSettled([...this.#active]).then(() => this.#cleanup()); }
  #cleanup(): void { if (this.#root) { const target = resolve(this.#root); if (!isWithin(target, resolve(this.options.tempDir), this.deps.executor.toolContext(this.controller.signal).platform) || target === resolve(this.options.tempDir)) throw Error("Unsafe speculative cleanup"); rmSync(target, { recursive: true, force: true }); this.#root = undefined; } }
}
