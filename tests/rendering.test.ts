// Terminal rendering engine (SPEC-IHM-001) and layout (SPEC-IHM-002), on the emulated terminal of the tests.
import { describe, expect, test } from "bun:test";
import { detectCapabilities, type Capabilities } from "../src/ui/capabilities";
import { composeFrame, TOO_SMALL, TRUNCATED } from "../src/ui/frame";
import { box, layoutNode, text, type LayoutContext, type Node } from "../src/ui/layout";
import { Screen, type Frame, type Scheduler } from "../src/ui/screen";
import { tone } from "../src/ui/style";
import { openTerminalSession } from "../src/ui/terminal-session";
import { lineText, sanitize, spansToLines, wrapLine } from "../src/ui/text";
import { fakeTerminal, VTerm } from "./helpers/vterm";

const CAPS: Capabilities = { colors: "truecolor", unicode: "full", synchronizedOutput: true, bracketedPaste: true, reflowOnResize: false };
const CTX: LayoutContext = { unicode: "full", narrow: false };

/** A screen on an emulated terminal, whose live area shows the node returned by `view`. */
function screenOn(vt: VTerm, view: () => Node, caps: Capabilities = CAPS) {
  const term = { write: (d: string) => vt.write(d), get columns() { return vt.columns; }, get rows() { return vt.rows; } };
  const screen = new Screen({ terminal: term, capabilities: caps, maxFramesPerSecond: 1000, source: (size) => layoutNode(view(), size.columns, CTX) });
  screen.start();
  return screen;
}

const lines = (...t: string[]) => t.map((s) => spansToLines([{ text: s }])[0]!);

describe("SPEC-IHM-001 rendering engine", () => {
  test("SPEC-IHM-001/CA-01 — a change on one line rewrites only the cells of that line", () => {
    const vt = new VTerm(40, 10);
    const items = ["item 1", "item 2", "item 3", "item 4"];
    const screen = screenOn(vt, () => box(items.map((i) => text(i))));
    screen.flush();
    expect(vt.screen().slice(0, 4)).toEqual(items);
    vt.resetCounters();
    items[2] = "item X";
    screen.flush();
    expect(vt.screen().slice(0, 4)).toEqual(["item 1", "item 2", "item X", "item 4"]);
    expect(vt.written).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    // EF-01: nothing changes, nothing is written.
    vt.resetCounters();
    screen.flush();
    expect(vt.written.every((n) => n === 0)).toBe(true);
  });

  test("SPEC-IHM-001/CA-02 — without colour, a coloured information stays identifiable by its symbol", () => {
    const caps = detectCapabilities({ colorMode: "auto", unicodeLevel: "full", noColorOption: false, variable: (n) => (n === "NO_COLOR" ? "1" : undefined), platform: "linux" });
    expect(caps.colors).toBe("none");
    const vt = new VTerm(40, 5);
    const error = tone("error", caps.unicode);
    const screen = screenOn(vt, () => text([{ text: `${error.symbol} `, style: error.style }, { text: "Échec de la commande", style: error.style }]), { ...CAPS, colors: "none" });
    screen.flush();
    expect(vt.screen()[0]).toBe("✗ Échec de la commande");
    expect(vt.chunks.join("")).not.toMatch(/\u001b\[[0-9;]*(3[0-7]|9[0-7]|38;)/);
    // The symbol does not depend on the colour: the same with colours, and in ASCII.
    expect(tone("error", "ascii").symbol).toBe("x");
    expect(detectCapabilities({ colorMode: "auto", unicodeLevel: "full", noColorOption: true, variable: () => undefined, platform: "windows" }).colors).toBe("none");
  });

  test("SPEC-IHM-001/CA-03 — control sequences in a content are escaped and have no effect", () => {
    const vt = new VTerm(60, 6);
    const hostile = "a\u001b[2J\u001b]0;title\u0007b\rc\u009bd‮e";
    const screen = screenOn(vt, () => box([text("before"), text(hostile)]));
    screen.flush();
    expect(vt.screen()[0]).toBe("before");
    expect(vt.screen()[1]).toBe("a^[[2J^[]0;title^Gb^Mc<U+009B>d<U+202E>e");
    expect(sanitize("x\u0000y\u007f")).toBe("x^@y^?");
  });

  test("SPEC-IHM-001/CA-04 — an exit by an uncaught error restores cursor, attributes and modes", () => {
    const term = fakeTerminal(40, 8);
    const session = openTerminalSession(term, {
      capabilities: CAPS,
      maxFramesPerSecond: 1000,
      source: (size) => ({ ...layoutNode(text([{ text: "styled", style: { bold: true, fg: { ansi: 1 } } }]), size.columns, CTX), cursor: undefined }),
    });
    session.screen.flush();
    expect(term.vt.raw).toBe(true);
    expect(term.vt.modes.has("2004")).toBe(true);
    // The renderer hides the cursor while it draws; an error leaves the process through its exit hook.
    term.vt.write("\u001b[?25l\u001b[1;31m");
    term.exitProcess();
    expect(term.vt.raw).toBe(false);
    expect(term.vt.cursorVisible).toBe(true);
    expect(term.vt.sgr).toBe("");
    expect(term.vt.modes.has("2004")).toBe(false);
    expect(term.vt.modes.has("2026")).toBe(false);
    expect(term.vt.modes.has("1000")).toBe(false);
    session.close(); // idempotent
  });

  test("SPEC-IHM-001/CA-05 — a resize recomputes the display without residue", () => {
    const term = fakeTerminal(50, 10);
    const view = (columns: number) => box([text(`width ${columns}`), text("─".repeat(Math.min(columns, 60)))]);
    const session = openTerminalSession(term, { capabilities: CAPS, maxFramesPerSecond: 1000, source: (size) => layoutNode(view(size.columns), size.columns, CTX) });
    session.screen.commit(lines("committed"));
    expect(term.vt.screen().slice(0, 3)).toEqual(["committed", "width 50", "─".repeat(50)]);
    term.resize(70, 10);
    expect(term.vt.screen().slice(0, 4)).toEqual(["committed", "width 70", "─".repeat(60), ""]);
    term.resize(30, 10);
    expect(term.vt.screen().slice(0, 4)).toEqual(["committed", "width 30", "─".repeat(30), ""]);
    expect(term.vt.all().filter((l) => l.startsWith("width")).length).toBe(1);
    session.close();
  });

  test("SPEC-IHM-001/CA-06 — double-width characters keep the following columns aligned", () => {
    const vt = new VTerm(40, 6);
    const row = (left: string) => box([box([text(left)], { width: 10 }), box([text("|right")], { width: "grow" })], { direction: "row" });
    const screen = screenOn(vt, () => box([row("日本語"), row("abc"), row("été 👍")]));
    screen.flush();
    const at = (r: number) => vt.grid[r]!.findIndex((c) => c.ch === "|");
    expect(at(0)).toBe(10);
    expect(at(1)).toBe(10);
    expect(at(2)).toBe(10);
    expect(vt.screen()[0]).toBe("日本語    |right");
  });

  test("TECH — SPEC-IHM-001/EF-06, ENF-02 — frames are grouped under the maximal rate; nothing is scheduled when idle", () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const scheduler: Scheduler = { now: () => now, setTimeout: (fn, ms) => (timers.push({ at: now + ms, fn }), timers.length), clearTimeout: () => {} };
    const vt = new VTerm(20, 4);
    let n = 0;
    const term = { write: (d: string) => vt.write(d), columns: 20, rows: 4 };
    const screen = new Screen({ terminal: term, capabilities: CAPS, maxFramesPerSecond: 10, scheduler, source: (size) => layoutNode(text(`n=${n}`), size.columns, CTX) });
    screen.flush();
    for (let i = 0; i < 50; i++) {
      n++;
      screen.invalidate();
    }
    expect(timers.length).toBe(1);
    expect(timers[0]!.at).toBe(100);
    expect(screen.stats.coalesced).toBe(49);
    now = 100;
    timers.shift()!.fn();
    expect(vt.screen()[0]).toBe("n=50");
    expect(timers.length).toBe(0);
  });
});

describe("SPEC-IHM-002 layout and scrolling", () => {
  test("SPEC-IHM-002/CA-01 — with 2,000 messages, rendering a new frame costs as much as in an empty session", () => {
    const live = () => box([text("› typing a message"), text("status")]);
    const empty = screenOn(new VTerm(80, 24), live);
    empty.flush();
    const long = screenOn(new VTerm(80, 24), live);
    for (let i = 0; i < 2000; i++) long.commit(lines(`message ${i}`));
    long.flush();
    expect(long.stats.lastLines).toBe(empty.stats.lastLines);
    const before = long.stats.frames;
    long.flush();
    expect(long.stats.frames).toBe(before + 1);
    expect(long.stats.lastCells).toBe(0);
  });

  test("SPEC-IHM-002/CA-02 — committed messages go to the native scrollback once, as plain text, and are never rewritten", () => {
    const vt = new VTerm(40, 6);
    let tick = 0;
    const screen = screenOn(vt, () => box([text(`producing ${tick}`), text("› input")]));
    for (let i = 1; i <= 8; i++) screen.commit(lines(`old message ${i}`));
    vt.resetCounters();
    for (tick = 1; tick < 20; tick++) screen.flush();
    const all = vt.all();
    for (let i = 1; i <= 8; i++) expect(all.filter((l) => l === `old message ${i}`).length).toBe(1);
    // Only the live rows (the last two of the screen) were written again.
    const liveTop = vt.screen().indexOf("producing 19");
    expect(vt.written.slice(0, liveTop).every((n) => n === 0)).toBe(true);
    expect(vt.scrollback.length).toBeGreaterThan(0);
  });

  test("SPEC-IHM-002/CA-04 — a resize neither duplicates nor loses content", () => {
    const term = fakeTerminal(60, 8);
    const session = openTerminalSession(term, { capabilities: CAPS, maxFramesPerSecond: 1000, source: (size) => layoutNode(box([text("live line"), text(`› ${size.columns}`)]), size.columns, CTX) });
    for (let i = 1; i <= 5; i++) session.screen.commit(lines(`entry ${i}`));
    term.resize(40, 8);
    term.resize(70, 8);
    const all = term.vt.all();
    for (let i = 1; i <= 5; i++) expect(all.filter((l) => l === `entry ${i}`).length).toBe(1);
    expect(all.filter((l) => l === "live line").length).toBe(1);
    expect(all[all.length - 1]).toBe("› 70");
    session.close();
  });

  test("SPEC-IHM-002/CA-06 — in a window of 5 lines, the input area and the status line stay visible", () => {
    const stream = box(Array.from({ length: 20 }, (_, i) => text(`stream ${i}`)));
    const zones = { stream, panels: [text("panel")], input: text("› hello", { caret: 7 }), status: text("status") };
    const f = composeFrame(zones, { columns: 40, rows: 5 }, { unicode: "full", minColumns: 20, retainedLines: 2000 });
    expect(f.lines.map(lineText)).toEqual(["stream 18", "stream 19", "panel", "› hello", "status"]);
    expect(f.cursor).toEqual({ row: 3, col: 7 });
    // ERR-01: below the minimal height, a message asks for a bigger window.
    const tiny = composeFrame(zones, { columns: 60, rows: 1 }, { unicode: "full", minColumns: 20, retainedLines: 2000 });
    expect(tiny.tooSmall).toBe(true);
    expect(lineText(tiny.lines[0]!)).toBe(TOO_SMALL);
  });

  test("TECH — SPEC-IHM-002/EF-04 — wrapping at word boundaries; a long word is cut; a double-width character is never cut", () => {
    const wrap = (s: string, w: number) => wrapLine(spansToLines([{ text: s }])[0]!, w).map(lineText);
    expect(wrap("le chat dort sur le tapis", 10)).toEqual(["le chat", "dort sur", "le tapis"]);
    expect(wrap("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
    expect(wrap("ab日本語", 5)).toEqual(["ab日", "本語"]);
    expect(wrap("a   b", 2)).toEqual(["a", "b"]);
  });

  test("TECH — SPEC-IHM-002/ERR-02, EF-07, SPEC-IHM-001/ERR-03 — retained lines, horizontal scroll, narrow terminal", () => {
    const f = composeFrame({ stream: box(Array.from({ length: 30 }, (_, i) => text(`l${i}`))), input: text("›") }, { columns: 40, rows: 50 }, { unicode: "ascii", minColumns: 20, retainedLines: 10 });
    expect(f.truncated).toBe(true);
    expect(lineText(f.lines[0]!)).toBe(`i ${TRUNCATED}`);
    expect(lineText(f.lines[1]!)).toBe("l20");
    const wide = layoutNode(text("0123456789abcdef", { overflow: "scroll", scrollX: 4 }), 8, { unicode: "ascii", narrow: false }).lines.map(lineText);
    expect(wide).toEqual(["<56789a>"]);
    const narrow = layoutNode(box([box([text("A")], { width: 5 }), text("B")], { direction: "row", border: {} }), 15, { unicode: "ascii", narrow: true }).lines.map(lineText);
    expect(narrow).toEqual(["A", "B"]);
    const bordered = layoutNode(box([text("in")], { border: { title: "T" } }), 10, { unicode: "ascii", narrow: false }).lines.map(lineText);
    expect(bordered).toEqual(["+- T ----+", "|in      |", "+--------+"]);
  });
});
