// Implements: SPEC-MOT-021 (tool-specific advice, structured analysis, conserved total).
// Supports: SPEC-CMD-014, SPEC-MOT-010, E-157.
import { estimatePart, type ContextMeter } from "../engine/context-meter";
import type { Conversation } from "../engine/conversation";
import type { HistoryMessage } from "../providers/types";

export function analyseContext(conversation: Conversation, meter: ContextMeter, autoCompact: boolean, history: readonly HistoryMessage[] = conversation.messages) {
  const local = meter.breakdown(conversation.system, conversation.tools, history);
  const occupation = meter.occupation(conversation.system, conversation.tools, history, conversation.segment);
  const localTotal = Object.values(local).reduce((a, b) => a + b, 0);
  // Provider totals are authoritative; local categories are a proportional estimate, with rounding conserved.
  let allocated = 0;
  const entries = Object.entries(local).map(([name, tokens], index, all) => {
    const n = index === all.length - 1 ? occupation.tokens - allocated : Math.floor(tokens * occupation.tokens / Math.max(1, localTotal));
    allocated += n;
    return { name, tokens: n, ratio: n / occupation.effectiveWindow };
  });
  const names = new Map<string, string>(), byTool = new Map<string, number>();
  for (const m of history) {
    if (m.role === "assistant") for (const call of m.toolCalls) names.set(call.callId, call.name);
    if (m.role !== "user") continue;
    for (const part of m.parts) if (part.type === "tool_result") {
      const name = names.get(part.callId) ?? "other", n = estimatePart(part, meter.coefficients).tokens;
      byTool.set(name, (byTool.get(name) ?? 0) + n);
    }
  }
  const tools = [...byTool].map(([name, tokens]) => ({ name, tokens, ratio: tokens / occupation.effectiveWindow })).sort((a, b) => b.tokens - a.tokens);
  const suggestions: Array<{ level: "warning" | "info"; text: string }> = [];
  if (occupation.ratio >= .8) suggestions.push({ level: "warning", text: `Utilisez /compact pour libérer du contexte ; compaction automatique ${autoCompact ? "active" : "désactivée"}.` });
  for (const tool of tools) if (tool.ratio >= .3) {
    const advice = ["run_shell", "run_powershell", "background_output", "monitor_process"].includes(tool.name) ? "Filtrer les sorties de commandes avant de les joindre : sélectionner les lignes utiles ou résumer les résultats." : tool.name === "read_file" ? "Lire des plages ciblées avec read_file (offset et limit)." : tool.name === "search_content" ? "Restreindre search_content par chemin et motif." : tool.name === "fetch_url" ? "Restreindre les pages web et conserver les extraits utiles." : "Réduire les résultats de cet outil avant le prochain tour.";
    suggestions.push({ level: "info", text: `${tool.name} : ${advice}` });
  }
  if (!autoCompact) suggestions.push({ level: "warning", text: "Activez context.autoCompact.enabled dans /preferences pour réduire le risque de saturation." });
  suggestions.sort((a, b) => Number(b.level === "warning") - Number(a.level === "warning"));
  return { version: 1, occupation, categories: entries, tools, freeTokens: Math.max(0, occupation.effectiveWindow - occupation.tokens), suggestions };
}

export function renderContextAnalysis(report: ReturnType<typeof analyseContext>): string {
  const names: Record<string, string> = { system: "Instructions système", tools: "Outils", messages: "Messages", attachments: "Pièces jointes" };
  const row = (label: string, n: number) => `${label.padEnd(22)} ${String(n).padStart(9)}  ${(100 * n / report.occupation.effectiveWindow).toFixed(1).padStart(5)} %`;
  const grid = `${"█".repeat(Math.round(report.occupation.ratio * 40))}${"·".repeat(40 - Math.round(report.occupation.ratio * 40))}`;
  return ["Contexte [" + grid + "] (plein / libre)", "Catégorie                  Jetons  Fenêtre", ...report.categories.map(c => row(names[c.name] ?? c.name, c.tokens)), row("Total", report.occupation.tokens), row("Espace libre", report.freeTokens), `Fenêtre effective : ${report.occupation.effectiveWindow} jetons (${report.occupation.fromProvider ? "total du fournisseur, répartition estimée" : "estimation locale"}).`, ...report.tools.map(t => row(`Résultats ${t.name}`, t.tokens)), ...report.suggestions.map(s => `${s.level === "warning" ? "Attention" : "Conseil"} : ${s.text}`)].join("\n");
}
