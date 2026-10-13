// Implements: SPEC-MOD-001 (FA-06 history shown again on reopening, § 11 `ui.replayOnResume`, RG-02)
// The history of a reopened session, shown again before the input area: condensed (messages of the user and answers of
// the model, a few lines each) or full (calls of tools and their results as well).

import type { TranscriptRecord } from "../session/transcript";
import { principalElement, type InteractiveApp } from "./app";
import { interruptionView, modelView, toolCallView, toolResultView, userView } from "./views";

const CONDENSED_LINES = 4;

function condense(text: string, full: boolean): string {
  if (full) return text;
  const lines = text.split("\n");
  return lines.length <= CONDENSED_LINES ? text : `${lines.slice(0, CONDENSED_LINES).join("\n")}\n… (${lines.length - CONDENSED_LINES} lignes de plus)`;
}

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.flatMap((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? [String((p as { text?: unknown }).text ?? "")] : [])).join("\n") : typeof content === "string" ? content : "";

export function replayHistory(app: InteractiveApp, chain: readonly TranscriptRecord[], full: boolean, describe: (name: string, input: unknown) => string): void {
  const view = app.viewContext;
  let shown = 0;
  for (const r of chain) {
    const d = r.data;
    if (r.type === "compaction") app.markCompacted();
    if (r.type === "user" && !d["synthetic"] && !d["fromHook"]) {
      const text = textOf(d["content"]);
      if (text) {
        app.commit(userView(condense(text, full), view));
        app.record("user", "", text, { recordId: r.id });
        shown++;
      }
    } else if (r.type === "assistant") {
      const text = typeof d["text"] === "string" ? d["text"].trim() : "";
      if (text) {
        app.commit(modelView(condense(text, full), view));
        app.record("model", "", text);
      }
      for (const c of (d["toolCalls"] as Array<{ name: string; input: unknown }> | undefined) ?? []) {
        if (full) app.commit(toolCallView(c.name, describe(c.name, c.input), view));
        app.record("tool", `${c.name}  ${describe(c.name, c.input)}`, JSON.stringify(c.input ?? {}, null, 2), { primary: principalElement(c.input) });
      }
    } else if (r.type === "tool_result") {
      // The view holds the whole transcript, the flow only what the replay mode shows.
      if (full) app.commit(toolResultView(textOf(d["content"]), d["isError"] === true, view));
      app.record("result", d["isError"] === true ? "(erreur)" : "", textOf(d["content"]));
    } else if (r.type === "system" && d["event"] === "turn_end" && d["stopCause"] === "interrupted") {
      app.commit(interruptionView(view));
    }
  }
  if (shown > 0) app.notice("system", "Session reprise : la conversation continue.");
}
