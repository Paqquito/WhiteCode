// Implements: SPEC-MOD-001 (§ 10 conversation flow, FA-01 interruption marker, FA-06 condensed replay, ERR-03), SPEC-IHM-001 (EF-03 information doubled by a symbol)
// Display of the items of the conversation: messages of the user and of the model, calls of tools and their results,
// notices of the product. The marks of the product are textual, so that they stay readable without colour.

import { box, text, type Node } from "../ui/layout";
import { tone, type Style, type Tone, type UnicodeLevel } from "../ui/style";
import type { Span } from "../ui/text";

export interface ViewContext {
  readonly unicode: UnicodeLevel;
  /** Rendering of the rich text of the model (SPEC-IHM-003); plain text otherwise. */
  readonly markdown?: (content: string) => Node;
}

const MARKS: Readonly<Record<UnicodeLevel, { user: string; model: string; tool: string; result: string; spinner: readonly string[] }>> = {
  full: { user: "›", model: "●", tool: "◆", result: "└", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] },
  restricted: { user: ">", model: "*", tool: "+", result: "`", spinner: ["|", "/", "-", "\\"] },
  ascii: { user: ">", model: "*", tool: "+", result: "`", spinner: ["|", "/", "-", "\\"] },
};

export const marks = (u: UnicodeLevel) => MARKS[u];

/** A block with a mark in front of its first line and an indentation for the others. */
function marked(mark: string, markStyle: Style | undefined, body: readonly Span[] | Node): Node {
  const content = Array.isArray(body) ? text(body as readonly Span[]) : (body as Node);
  return box([box([text([{ text: mark, style: markStyle }])], { width: 2 }), box([content], { width: "grow" })], { direction: "row" });
}

export function userView(content: string, v: ViewContext): Node {
  return marked(marks(v.unicode).user, { dim: true }, [{ text: content, style: { bold: true } }]);
}

/**
 * The text of the model, under its mark and indented: a content imitating a notice of the product stays inside this
 * block, visibly distinct from the real notices, which start in the first column (CA-06 of SPEC-IHM-003).
 */
export function modelView(content: string | Node, v: ViewContext): Node {
  const body = typeof content === "string" ? (v.markdown ? v.markdown(content) : text(content)) : content;
  return marked(marks(v.unicode).model, undefined, body);
}

export function toolCallView(name: string, summary: string, v: ViewContext): Node {
  return marked(marks(v.unicode).tool, { fg: { ansi: 4 } }, [{ text: name, style: { bold: true } }, ...(summary ? [{ text: `  ${summary}`, style: { dim: true } }] : [])]);
}

/** One line for a result: its first line and the number of the others, or the error. */
export function toolResultView(output: string, isError: boolean, v: ViewContext): Node {
  const lines = output.replace(/\s+$/, "").split("\n");
  const first = lines[0] ?? "";
  const rest = lines.length > 1 ? ` (+${lines.length - 1} lignes)` : "";
  const head = first.length > 160 ? `${first.slice(0, 157)}…` : first;
  const t = tone("error", v.unicode);
  return box([text([{ text: `  ${marks(v.unicode).result} `, style: { dim: true } }, ...(isError ? [{ text: `${t.symbol} `, style: t.style }] : []), { text: head || "(aucune sortie)", style: { dim: true } }, { text: rest, style: { dim: true } }])]);
}

/** A notice of the product: its tone is given by a symbol as well as by its colour. */
export function noticeView(t: Tone, message: string, v: ViewContext): Node {
  const s = tone(t, v.unicode);
  return marked(s.symbol, s.style, [{ text: message, style: t === "error" ? s.style : t === "system" ? { dim: true } : undefined }]);
}

/** FA-01 of SPEC-MOD-001: the marker of an interrupted turn. */
export function interruptionView(v: ViewContext): Node {
  const s = tone("warning", v.unicode);
  return box([text([{ text: `  ${marks(v.unicode).result} `, style: { dim: true } }, { text: `${s.symbol} Interrompu par l'utilisateur.`, style: s.style }])]);
}

export function activityView(label: string, elapsedMs: number, frame: number, v: ViewContext): Node {
  const m = marks(v.unicode);
  const seconds = Math.floor(elapsedMs / 1000);
  return text([
    { text: `${m.spinner[frame % m.spinner.length]} `, style: { fg: { ansi: 5 } } },
    { text: label },
    { text: ` (${seconds} s · Échap pour interrompre)`, style: { dim: true } },
  ]);
}
