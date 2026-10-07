// Implements: SPEC-IHM-002 (§ 5.3 structure of the screen, § 5.4 points 2 and 3, EF-02, FA-01, FA-05, ERR-01, ERR-02, RG-02, CA-06), SPEC-IHM-001 (§ 5.4 simplified display, ERR-03)
// Composition of the live area, from top to bottom: the content being produced, the temporary panels, the input area
// and the status line. The fixed zones keep their minimal height; the content being produced gets what remains and
// follows its bottom.

import { layoutNode, text, type LayoutContext, type Node } from "./layout";
import type { Frame } from "./screen";
import { tone, type UnicodeLevel } from "./style";
import type { Cell } from "./text";

export interface Zones {
  /** Content being produced (finished content is committed to the scrollback). */
  readonly stream?: Node;
  /** Temporary panels (permission dialog, lists), above the input area (FA-05). */
  readonly panels?: readonly Node[];
  readonly input: Node;
  readonly status?: Node;
}

export interface ComposeOptions {
  readonly unicode: UnicodeLevel;
  /** `ui.minColumns`: below, one column without decoration (ERR-03 of SPEC-IHM-001). */
  readonly minColumns: number;
  /** `ui.retainedLines`: lines of a content being produced kept for display (§ 5.4 point 3, ERR-02). */
  readonly retainedLines: number;
}

export interface ComposedFrame extends Frame {
  readonly narrow: boolean;
  readonly tooSmall: boolean;
  /** The content being produced exceeded the retained lines (ERR-02). */
  readonly truncated: boolean;
}

export const TOO_SMALL = "Fenêtre trop petite pour afficher l'interface.";
export const TRUNCATED = "Contenu tronqué à l'affichage.";

export function composeFrame(zones: Zones, size: { columns: number; rows: number }, o: ComposeOptions): ComposedFrame {
  const width = size.columns;
  const narrow = width < o.minColumns;
  const ctx: LayoutContext = { unicode: o.unicode, narrow };
  const status = zones.status ? layoutNode(zones.status, width, ctx).lines.slice(0, 1) : [];
  const input = layoutNode(zones.input, width, ctx);
  // ERR-01: below one line of input and the status line, the interface cannot be shown.
  if (size.rows < 1 + status.length) {
    return { lines: layoutNode(text(TOO_SMALL, { overflow: "clip" }), width, ctx).lines.slice(0, Math.max(1, size.rows)), narrow, tooSmall: true, truncated: false };
  }
  // EF-02, FA-01: the input area keeps at least its line with the cursor; it gives up its other lines when space lacks.
  let inputLines = input.lines;
  let cursor = input.cursor;
  const inputRoom = size.rows - status.length;
  if (inputLines.length > inputRoom) {
    const focus = cursor?.row ?? inputLines.length - 1;
    const start = Math.max(0, Math.min(focus - inputRoom + 1, inputLines.length - inputRoom));
    inputLines = inputLines.slice(start, start + inputRoom);
    cursor = cursor ? { row: cursor.row - start, col: cursor.col } : undefined;
  }
  let room = size.rows - status.length - inputLines.length;
  // FA-05: the panels take the place they need, at the expense of the content being produced.
  const panels: Cell[][] = [];
  for (const p of zones.panels ?? []) {
    if (room <= 0) break;
    const laid = layoutNode(p, width, ctx).lines;
    const kept = laid.slice(0, room);
    panels.push(...kept);
    room -= kept.length;
  }
  let stream: Cell[][] = [];
  let truncated = false;
  if (zones.stream && room > 0) {
    stream = layoutNode(zones.stream, width, ctx).lines;
    if (stream.length > o.retainedLines) {
      truncated = true;
      const t = tone("info", o.unicode);
      const marker = layoutNode(text([{ text: `${t.symbol} ${TRUNCATED}`, style: { dim: true } }], { overflow: "clip" }), width, ctx).lines;
      stream = [...marker, ...stream.slice(stream.length - o.retainedLines)];
    }
    // Bottom anchoring: the most recent lines of the content being produced stay visible.
    if (stream.length > room) stream = stream.slice(stream.length - room);
  }
  const top = stream.length + panels.length;
  return {
    lines: [...stream, ...panels, ...inputLines, ...status],
    cursor: cursor ? { row: top + cursor.row, col: cursor.col } : undefined,
    narrow,
    tooSmall: false,
    truncated,
  };
}
