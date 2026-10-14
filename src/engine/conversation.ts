// Implements: decision D-12 (append-only history within a segment), SPEC-MOT-001 (RG-01, RG-02), SPEC-MOT-023 (EF-02)
// Supports: SPEC-SES-001 (every appended message is persisted), SPEC-SES-002 (history of a reopened session)
// Supports: SPEC-API-006 (CA-02: a capability change starts a new request prefix without losing history), gap E-145.
// Only appends, a new segment after a compaction, and the micro-compaction rewrite reserved to non append-only models.

import type { ContentPart, HistoryMessage, SystemBlock, ToolDefinition, ToolResultPart } from "../providers/types";

export class Conversation {
  #system: readonly SystemBlock[];
  #tools: readonly ToolDefinition[];
  readonly #messages: HistoryMessage[] = [];
  #segment = 0;
  #toolsEnabled?: boolean;

  constructor(system: readonly SystemBlock[], tools: readonly ToolDefinition[]) {
    this.#system = system;
    this.#tools = tools;
  }

  get segment(): number {
    return this.#segment;
  }

  get system(): readonly SystemBlock[] {
    return this.#system;
  }

  get tools(): readonly ToolDefinition[] {
    return this.#tools;
  }

  /** A model capability change replaces the advertised tool set, so it opens a new prefix epoch. */
  toolsForModel(enabled: boolean): readonly ToolDefinition[] {
    if (this.#toolsEnabled !== undefined && this.#toolsEnabled !== enabled) this.#segment++;
    this.#toolsEnabled = enabled;
    return enabled ? this.#tools : [];
  }

  get messages(): readonly HistoryMessage[] {
    return this.#messages;
  }

  /** History of a reopened session (SPEC-SES-002 step 2), before any new message. */
  restore(messages: readonly HistoryMessage[]): void {
    if (this.#messages.length > 0) throw new Error("restore() is only allowed on an empty conversation");
    this.#messages.push(...messages);
  }

  appendUser(parts: ReadonlyArray<ContentPart | ToolResultPart>): void {
    this.#messages.push({ role: "user", parts: [...parts] });
  }

  /** Supports: SPEC-IHM-017 CA-02. A confirmed branch opens a new prefix epoch. */
  branch(messages: readonly HistoryMessage[]): void { this.#messages.splice(0, this.#messages.length, ...messages); this.#segment++; }

  appendAssistant(message: Extract<HistoryMessage, { role: "assistant" }>): void {
    this.#messages.push(message);
  }

  /** Every result of one response in a single user message, in call order (SPEC-MOT-001 EF-03). */
  appendToolResults(results: readonly ToolResultPart[]): void {
    this.#messages.push({ role: "user", parts: [...results] });
  }

  /** Operator note (reminder, mode change): appended, never removed (D-12). */
  appendNote(text: string): void {
    this.#messages.push({ role: "system_note", text });
  }

  /**
   * Tools that appear during the segment (connector connected, deferred tool loaded): appended after the others, so
   * that the definitions already sent keep their place (SPEC-OUT-030 EF-02, SPEC-MCP-022 § 5.1). Returns the names added.
   */
  extendTools(tools: readonly ToolDefinition[]): string[] {
    const known = new Set(this.#tools.map((t) => t.name));
    const added = tools.filter((t) => !known.has(t.name));
    if (added.length > 0) this.#tools = [...this.#tools, ...added];
    return added.map((t) => t.name);
  }

  /** Supports: SPEC-OUT-029, SPEC-MCP-022 (explicit authorization/disable revokes a definition and its cached prefix). */
  retireTools(remove: (name: string) => boolean): void {
    const next = this.#tools.filter(tool => !remove(tool.name));
    if (next.length !== this.#tools.length) { this.#tools = next; this.#segment++; }
  }

  /** Opens a new segment after a full compaction: nothing of the previous segment is replayed (architecture § 7.2). */
  startSegment(system: readonly SystemBlock[], tools: readonly ToolDefinition[], opening: ReadonlyArray<ContentPart>, retained: readonly HistoryMessage[] = []): void {
    this.#system = system;
    this.#tools = tools;
    this.#messages.length = 0;
    this.#messages.push({ role: "user", parts: [...opening] });
    this.#messages.push(...retained);
    this.#segment++;
  }

  /**
   * Local micro-compaction (SPEC-MOT-013): replaces the content of old tool results. Allowed only for a model whose
   * history is not append-only (capability `appendOnlyHistory` false, decision D-12); the prefix changes, so a new
   * prefix epoch starts (the segment counter moves on). Returns the number of results replaced.
   */
  rewriteToolResults(replace: (part: ToolResultPart) => ToolResultPart | undefined): number {
    let count = 0;
    for (let i = 0; i < this.#messages.length; i++) {
      const m = this.#messages[i]!;
      if (m.role !== "user") continue;
      let changed = false;
      const parts = m.parts.map((p) => {
        if (p.type !== "tool_result") return p;
        const next = replace(p);
        if (!next) return p;
        changed = true;
        count++;
        return next;
      });
      if (changed) this.#messages[i] = { role: "user", parts };
    }
    if (count > 0) this.#segment++;
    return count;
  }

  /** Tool calls of the last assistant message that have no result yet (RG-01 check). */
  pendingCalls(): string[] {
    const last = this.#messages[this.#messages.length - 1];
    if (!last || last.role !== "assistant") return [];
    return last.toolCalls.map((c) => c.callId);
  }
}
