import { expect, test } from "bun:test";
import { join } from "node:path";
import { Teams } from "../src/agents/teams";
import { InteractiveApp } from "../src/interactive/app";
import { workspace } from "./helpers/env";
import { fakeTerminal } from "./helpers/vterm";
import { sleep } from "./helpers/interactive";

test("SPEC-IHM-029/CA-01, SPEC-AGT-015/CA-02 — the teammate view delivers typed text to the displayed member and Escape returns to the leader", async () => {
  const calls: string[] = [], teams = new Teams({ folder: join(workspace().root, "teams"), enabled: () => true, maxMembers: () => 8, maxBytes: () => 65536, shutdownMs: () => 10, redact: value => value, notify: () => {}, run: async input => { calls.push(input.prompt); return { id: "member-context", text: "Member answer", isError: false }; } });
  teams.form("review"); teams.spawn("reader", "Initial member task");
  while (teams.members[0]?.state !== "idle") await sleep(5);
  let selected = true, mainReceived = false, cycles = 0; const term = fakeTerminal(100, 30);
  const app = new InteractiveApp({ terminal: term, capabilities: { colors: "truecolor", unicode: "full", synchronizedOutput: false, bracketedPaste: true, reflowOnResize: false },
    settings: { maxFramesPerSecond: 1000, minColumns: 40, retainedLines: 2000, inputMinHeight: 1, inputMaxHeight: 10, inputMaxChars: 100000, inputWarnChars: 20000, queueMax: 10, queueAutoSend: true, draftsMax: 10, exitConfirmation: true, exitDoublePressMs: 1500, dialogGuardMs: 0 },
    status: () => ({ mode: "ask", model: "fixture" }), describeCall: () => "", cycleMode: () => { cycles++; }, teammateView: () => selected ? { name: "reader", lines: ["Member answer"] } : undefined,
    sendToTeammate: value => { teams.send("lead", "reader", value); return true; }, leaveTeammate: () => { selected = false; },
  });
  try {
    app.start(); void app.nextEntry().then(() => { mainReceived = true; }); await sleep(20); expect(term.vt.screen().join("\n")).toContain("saisie adressée à reader");
    for (const character of "DIRECT_MEMBER_MESSAGE\r") term.type(character); await sleep(80); expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("DIRECT_MEMBER_MESSAGE"); expect(mainReceived).toBe(false); expect(app.queue).toEqual([]);
    term.type("\u001b"); await sleep(50); expect(selected).toBe(false);
    app.setSuggestion("Read the next file"); term.type("\u001b[Z"); await sleep(50); expect(cycles).toBe(1); expect(app.autonomousInputBusy).toBe(false);
  } finally { app.stop(); await teams.close(); }
});
