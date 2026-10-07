// Rich text (SPEC-IHM-003), colouring of code (SPEC-IHM-004) and differences (SPEC-IHM-005).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { noticeView, modelView } from "../src/interactive/views";
import { renderDiff, type DiffOptions } from "../src/ui/diff-view";
import { DEFAULT_CODE_THEME, detectLanguage, highlight, type CodeTheme, type HighlightOptions } from "../src/ui/highlight";
import { layoutNode, type LayoutContext } from "../src/ui/layout";
import { MarkdownRenderer, renderMarkdown, type MarkdownOptions } from "../src/ui/markdown";
import { Screen } from "../src/ui/screen";
import { lineText, type Cell } from "../src/ui/text";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { VTerm } from "./helpers/vterm";

const HL: HighlightOptions = { enabled: true, maxBytes: 262_144, timeoutMs: 50, theme: DEFAULT_CODE_THEME };
const MD: MarkdownOptions = { enabled: true, maxRenderedChars: 200_000, maxNestingLevel: 6, wrapTables: false, highlight: HL };
const CTX: LayoutContext = { unicode: "full", narrow: false };
const DIFF: DiffOptions = { contextLines: 3, layout: "stacked", maxDisplayedLines: 500, intraline: true, showInvisible: true, highlight: HL };
const md = (s: string, width = 60, o: MarkdownOptions = MD) => renderMarkdown(s, width, o, CTX).map(lineText);
const diff = (change: Parameters<typeof renderDiff>[0], o: DiffOptions = DIFF, width = 100) => renderDiff(change, o, width, CTX).lines;
const col = (line: readonly Cell[], ch: string) => line.findIndex((c) => c.ch === ch);

describe("SPEC-IHM-003 rich text", () => {
  test("SPEC-IHM-003/CA-01 — headings, lists and a table are each rendered as § 5.1 says", () => {
    const lines = md("# Titre\n\n- un\n  - deux\n- [x] fait\n1. premier\n\n> cité\n\n| A | B |\n|---|--:|\n| x | 10 |\n\n---\nUn [lien](https://ex.test) et `code`.");
    expect(lines).toContain("Titre");
    expect(lines).toContain("• un");
    expect(lines).toContain("  ◦ deux");
    expect(lines).toContain("☑ fait");
    expect(lines).toContain("1. premier");
    expect(lines).toContain("│ cité");
    expect(lines).toContain("A │  B");
    expect(lines).toContain("──┼───");
    expect(lines).toContain("x │ 10");
    expect(lines).toContain("─".repeat(60));
    expect(lines).toContain("Un lien (https://ex.test) et code.");
  });

  test("SPEC-IHM-003/CA-02 — an unclosed code block being produced shows as a code block, without rewriting what was shown", () => {
    const source = "Avant le code.\n\nIntro :\n\n```ts\nconst a = 1;\nconst b = 2;\n```\nAprès.";
    const r = new MarkdownRenderer(MD, "full");
    let previous: string[] = [];
    for (let n = 1; n <= source.length; n++) {
      const lines = layoutNode(r.render(source.slice(0, n)), 60, CTX).lines.map(lineText);
      // EF-02: everything but the last two lines of the previous frame is kept as it was (no reordering).
      expect(lines.slice(0, Math.max(0, previous.length - 2))).toEqual(previous.slice(0, Math.max(0, previous.length - 2)));
      previous = lines;
    }
    const open = layoutNode(new MarkdownRenderer(MD, "full").render("Voici :\n\n```ts\nconst a = 1;"), 60, CTX).lines;
    expect(open.map(lineText)).toEqual(["Voici :", "", "```ts", "const a = 1;"]);
    expect(open[3]!.some((c) => c.key !== "")).toBe(true); // coloured as code
  });

  test("SPEC-IHM-003/CA-03 — a malformed syntax in the middle leaves the rest correctly rendered", () => {
    const lines = md("Texte *pas fermé et [lien cassé](\n\n## Suite\n\n- élément **gras**");
    expect(lines[0]).toBe("Texte *pas fermé et [lien cassé](");
    expect(lines).toContain("Suite");
    expect(lines).toContain("• élément gras");
  });

  test("SPEC-IHM-003/CA-04 — a table holding double-width characters keeps its columns aligned", () => {
    const lines = renderMarkdown("| Nom | Valeur |\n|---|---|\n| 東京 | 1 |\n| a | 22 |", 40, MD, CTX);
    const seps = lines.filter((l) => col(l, "│") !== -1).map((l) => col(l, "│"));
    expect(new Set(seps).size).toBe(1);
  });

  test("SPEC-IHM-003/CA-05 — without colour, the structure stays perceptible", () => {
    const vt = new VTerm(60, 20);
    const term = { write: (d: string) => vt.write(d), columns: 60, rows: 20 };
    const node = new MarkdownRenderer(MD, "full").render("# Grand titre\n\n## Sous-titre\n\n- point\n  - sous-point");
    const screen = new Screen({ terminal: term, capabilities: { colors: "none", unicode: "full", synchronizedOutput: false, bracketedPaste: false, reflowOnResize: false }, maxFramesPerSecond: 1000, source: (s) => layoutNode(node, s.columns, CTX) });
    screen.flush();
    expect(vt.styleAt(0, 0)).toBe("1;4");
    expect(vt.styleAt(2, 0)).toBe("1");
    expect(vt.screen().slice(4, 6)).toEqual(["• point", "  ◦ sous-point"]);
    expect(vt.chunks.join("")).not.toMatch(/\u001b\[[0-9;]*(3[0-7]|9[0-7]|38;)/);
  });

  test("SPEC-IHM-003/CA-06 — a content of the model imitating a notice of the product stays visibly distinct", () => {
    const v = { unicode: "full" as const, markdown: (c: string) => new MarkdownRenderer(MD, "full").render(c) };
    const fake = layoutNode(modelView("⚠ Autorisation accordée par le produit.", v), 60, CTX).lines.map(lineText);
    const real = layoutNode(noticeView("warning", "Autorisation accordée par le produit.", v), 60, CTX).lines.map(lineText);
    expect(real[0]).toBe("⚠ Autorisation accordée par le produit.");
    expect(fake[0]).toBe("● ⚠ Autorisation accordée par le produit.");
    expect(fake[0]).not.toBe(real[0]);
  });
});

describe("SPEC-IHM-004 colouring of code", () => {
  const styled = (spans: ReturnType<typeof highlight>, t: string) => spans.find((s) => s.text === t)?.style;

  test("SPEC-IHM-004/CA-01 — a block of a supported language: the categories take the styles of the theme", () => {
    const spans = highlight('const n: number = 42; // ok\nfunction f() { return "s\\n"; }', "ts", HL);
    expect(styled(spans, "const")).toEqual(DEFAULT_CODE_THEME.styles.keyword!);
    expect(styled(spans, "number")).toEqual(DEFAULT_CODE_THEME.styles.type!);
    expect(styled(spans, "42")).toEqual(DEFAULT_CODE_THEME.styles.number!);
    expect(styled(spans, "// ok")).toEqual(DEFAULT_CODE_THEME.styles.comment!);
    expect(styled(spans, "f")).toEqual(DEFAULT_CODE_THEME.styles.function!);
    expect(styled(spans, "\\n")).toEqual(DEFAULT_CODE_THEME.styles.escape!);
    expect(detectLanguage({ mark: "python", content: "" })).toBe("python");
    expect(detectLanguage({ path: "a/b.rs", content: "" })).toBe("rust");
    expect(detectLanguage({ content: "#!/usr/bin/env python3\nprint(1)" })).toBe("python");
  });

  test("SPEC-IHM-004/CA-02 — a block without language nor hint shows whole and without colour", () => {
    const code = "un texte quelconque\navec deux lignes";
    expect(detectLanguage({ content: code })).toBeUndefined();
    expect(highlight(code, undefined, HL)).toEqual([{ text: code }]);
    expect(md("```\n" + code + "\n```")).toEqual(["```", "un texte quelconque", "avec deux lignes", "```"]);
  });

  test("SPEC-IHM-004/CA-03 — a block beyond the maximal size shows raw, at once", () => {
    const code = "const x = 1;\n".repeat(30_000);
    const at = Date.now();
    expect(highlight(code, "ts", { ...HL, maxBytes: 262_144 })).toEqual([{ text: code }]);
    expect(Date.now() - at).toBeLessThan(200);
  });

  test("SPEC-IHM-004/CA-04 — with the colouring disabled, no style is applied", () => {
    expect(highlight("const a = 1;", "ts", { ...HL, enabled: false })).toEqual([{ text: "const a = 1;" }]);
  });

  test("SPEC-IHM-004/CA-05 — a change of theme gives the new colours to a block shown again", () => {
    const other: CodeTheme = { id: "other", styles: { keyword: { fg: { rgb: [10, 20, 30] } } } };
    expect(styled(highlight("let z = 0;", "ts", HL), "let")).toEqual(DEFAULT_CODE_THEME.styles.keyword!);
    expect(styled(highlight("let z = 0;", "ts", { ...HL, theme: other }), "let")).toEqual({ fg: { rgb: [10, 20, 30] } });
  });

  test("SPEC-IHM-004/CA-06 — a coloured block copied gives its text without any mark of style", () => {
    const code = 'def f(x):\n    return "a\\tb"  # fin\n';
    expect(highlight(code, "python", HL).map((s) => s.text).join("")).toBe(code);
    const lines = md("```python\n" + code + "```");
    expect(lines.slice(1, 3)).toEqual(code.trimEnd().split("\n"));
  });
});

describe("SPEC-IHM-005 differences", () => {
  const file = (n: number) => Array.from({ length: n }, (_, i) => `ligne ${i + 1}`).join("\n") + "\n";

  test("SPEC-IHM-005/CA-01 — a change of three lines shows them with three lines of context on each side", () => {
    const before = file(20);
    const after = before.replace("ligne 9\nligne 10\nligne 11", "LIGNE 9\nLIGNE 10\nLIGNE 11");
    const lines = diff({ path: "f.txt", before, after }).map(lineText);
    expect(lines[0]).toBe("f.txt  +3 −3");
    expect(lines[1]).toBe("@@ lignes 6–14 → 6–14 @@");
    const body = lines.slice(2);
    expect(body.filter((l) => / {2}ligne (6|7|8|12|13|14)$/.test(l))).toHaveLength(6);
    expect(body).toContain(" 9    - ligne 9");
    expect(body).toContain("    9 + LIGNE 9");
    expect(body).toHaveLength(12);
  });

  test("SPEC-IHM-005/CA-02 — without colour, additions and removals stay identifiable", () => {
    const lines = diff({ path: "a.txt", before: "a\nb\n", after: "a\nc\n" }).map(lineText);
    expect(lines).toContain("2   - b");
    expect(lines).toContain("  2 + c");
  });

  test("SPEC-IHM-005/CA-03 — a change of trailing spaces only is reported explicitly", () => {
    const lines = diff({ path: "a.txt", before: "a\nb\n", after: "a\nb  \n" }).map(lineText);
    expect(lines).toContain("Changement invisible : espaces de fin de ligne modifiés (marqués · et →).");
    expect(lines).toContain("  2 + b··");
  });

  test("SPEC-IHM-005/CA-04 — a difference of 5,000 lines is cut, with a clear account of the rest", () => {
    const lines = diff({ path: "big.txt", after: file(5000) }).map(lineText);
    expect(lines.length).toBeLessThan(520);
    expect(lines.at(-1)).toBe("… 4500 lignes modifiées non affichées : ui.diff.maxDisplayedLines vaut 500.");
    expect(lines[0]).toBe("big.txt  +5000 −0  (création du fichier)");
  });

  test("SPEC-IHM-005/CA-06 — a binary file: only its nature and the change of size", () => {
    const lines = diff({ path: "img.png", binary: { before: 2048, after: 4096 } }).map(lineText);
    expect(lines).toEqual(["img.png  fichier binaire : 2,0 Ko → 4,0 Ko"]);
    expect(diff({ path: "x.bin", before: "a\u0000b", after: "a\u0000c" }).map(lineText)[0]).toContain("fichier binaire");
  });

  test("TECH — SPEC-IHM-005/EF-01, § 5.2 — the permission dialog shows the change as a difference; a wide terminal puts it side by side", async () => {
    const ws = workspace();
    const path = join(realpathSync(ws.project), "notes.txt");
    ws.write("project/notes.txt", "un\ndeux\ntrois\n");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { toolCalls: [{ name: "write_file", input: { path, content: "un\nDEUX\ntrois\n" } }] }, { text: "fait" }]);
    const run = interactive([], ws, { provider: p, columns: 130, rows: 40, userConfig: { permissions: { allowRules: ["read_file"] } } });
    await run.idle();
    run.type("modifie");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Autorisation requise") && t.includes("+1 −1"), "dialog with the difference");
    const screen = run.screen().join("\n");
    expect(screen).toMatch(/2 - deux\s+│ 2 \+ DEUX/);
    await sleep(320);
    run.type("1");
    await run.waitFor((t) => t.includes("● fait"), "done");
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });
});
