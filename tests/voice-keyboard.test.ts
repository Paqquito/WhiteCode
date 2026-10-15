// Supports: SPEC-VOX-001 (only actual press/release reports can govern microphone capture).
import { expect, test } from "bun:test";
import { KeyParser } from "../src/ui/keys";

test("TECH — enhanced keyboard reports preserve distinct press repeat and release phases", () => {
  const events = new KeyParser().feed(
    "\u001b[32;5:1u\u001b[32;5:2u\u001b[32;5:3u",
  );
  expect(events).toEqual(
    ["press", "repeat", "release"].map((phase) =>
      expect.objectContaining({
        kind: "key",
        name: "space",
        ctrl: true,
        phase,
      }),
    ),
  );
  expect(new KeyParser().feed("\u0000")).toEqual([
    expect.not.objectContaining({ phase: "press" }),
  ]);
});
test("TECH — invalid keyboard code points are ignored without crashing the input parser", () => {
  const parser = new KeyParser();
  expect(() => parser.feed("\u001b[99999999;5:1u")).not.toThrow();
  expect(parser.feed("\u001b[99999999;5:3u")).toEqual([
    expect.objectContaining({ kind: "key", name: "unknown" }),
  ]);
});
