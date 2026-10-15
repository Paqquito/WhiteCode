// Supports: SPEC-EXT-016, SPEC-PER-019 (untrusted native confirmation metadata is visible text).
import { expect, test } from "bun:test";
import { authDialog } from "../src/interactive/auth-dialog";
import { fakeTerminal } from "./helpers/vterm";
test("TECH — an archive confirmation cannot execute clipboard, cursor or bidirectional controls from its metadata", async () => {
  const terminal = fakeTerminal(), writes: string[] = [], controller = new AbortController();
  const answer = authDialog({ ...terminal, write: value => { writes.push(value); terminal.write(value); } }, "Archive description: \u001b]52;c;RklYVFVSRQ==\u0007\u001b[2J\u202eDanger", false, controller.signal);
  try { expect(writes.join("")).not.toContain("\u001b]52"); expect(writes.join("")).toContain("^["); expect(writes.join("")).toContain("<U+202E>"); }
  finally { controller.abort(); await answer; }
});
