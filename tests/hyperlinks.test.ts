import { expect, test } from "bun:test";
import { Hyperlinks } from "../src/ui/hyperlinks";
import { Screen } from "../src/ui/screen";
import { spansToLines } from "../src/ui/text";
import { workspace } from "./helpers/env";
test("SPEC-IHM-035/CA-01 — clicking the emitted editor hyperlink resolves the existing project file at its requested line", () => {
  const ws = workspace(),
    file = ws.write("project/src/hello world.ts", "one\ntwo\nthree\n"),
    links = new Hyperlinks({
      cwd: () => ws.project,
      scheme: () => "fixture-editor",
    }),
    raw: string[] = [];
  const screen = new Screen({
    terminal: { columns: 100, rows: 24, write: (d) => raw.push(d) },
    capabilities: {
      colors: "truecolor",
      unicode: "full",
      synchronizedOutput: false,
      bracketedPaste: true,
      reflowOnResize: false,
      hyperlinks: true,
    },
    maxFramesPerSecond: 60,
    source: () => ({ lines: [] }),
  });
  screen.start();
  screen.commit([
    links.line(spansToLines([{ text: "See src/hello world.ts:3:2" }])[0]!),
  ]);
  screen.stop();
  const target = /\x1b\]8;;([^\x1b]+)\x1b\\/.exec(raw.join(""))![1]!,
    opened = new URL(target);
  expect(opened.protocol).toBe("fixture-editor:");
  expect(opened.hostname).toBe("file");
  const decoded = decodeURI(opened.pathname).replace(/^\//, "");
  expect(decoded).toBe(file.replaceAll("\\", "/").replace(/^\//, "") + ":3:2");
  expect(raw.join("")).toContain("\x1b]8;;\x1b\\");
});
test("TECH — nonexistent files and hostile targets stay inert; terminals without link capability retain an underlined fallback", () => {
  const ws = workspace(),
    links = new Hyperlinks({ cwd: () => ws.project, scheme: () => "auto" }),
    line = links.line(
      spansToLines([
        {
          text: "missing.ts:4 javascript:alert(1) https://user:pass@example.test/x",
        },
      ])[0]!,
    );
  expect(line.some((c) => c.style?.href)).toBe(false);
  const existing = ws.write("project/code.ts", "code"),
    linked = links.line(spansToLines([{ text: existing + ":1" }])[0]!);
  expect(linked.some((c) => c.style?.underline)).toBe(true);
  const writes: string[] = [];
  const s = new Screen({
    terminal: { columns: 100, rows: 20, write: (v) => writes.push(v) },
    capabilities: {
      colors: "none",
      unicode: "ascii",
      synchronizedOutput: false,
      bracketedPaste: false,
      reflowOnResize: false,
    },
    maxFramesPerSecond: 60,
    source: () => ({ lines: [] }),
  });
  s.start();
  s.commit([linked]);
  s.stop();
  expect(writes.join("")).not.toContain("\x1b]8;");
});
