// Supports: SPEC-INT-018/CA-02 and SPEC-MOT-008/CA-03.
import { expect, test } from "bun:test";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-INT-018/CA-02 — copying a selected code block over SSH emits its exact UTF-8 through OSC 52", async () => {
  const controller = new AbortController(), block = "const été = '✓';\n", provider = new ScriptedProvider([{ text: "Explanation\n```ts\n" + block + "```\nAfter" }]); let localCopies = 0;
  const run = interactive([], workspace(), { provider, signal: controller.signal, env: { SSH_CONNECTION: "192.0.2.1 1234 192.0.2.2 22" }, extra: { copyText: async () => { localCopies++; return true; } } });
  const writes: string[] = [], original = run.term.write; run.term.write = text => { writes.push(text); original(text); };
  try {
    await run.idle(); run.type("Show a code block."); run.type(KEY.enter); await run.waitFor(text => text.includes("After")); await sleep(60);
    run.type("\u001bt"); run.type("s"); run.type("a"); run.type("2");
    await run.waitFor(() => writes.some(text => text.includes("\u001b]52;c;")), "OSC 52 copy");
    const encoded = writes.join("").match(/\u001b\]52;c;([^\u0007]+)\u0007/)?.[1];
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(block); expect(localCopies).toBe(0); expect(provider.requests).toHaveLength(1);
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-MOT-008/CA-03 — declining immediate send after interruption restores two queued messages into the draft", async () => {
  const controller = new AbortController(), provider = new ScriptedProvider([{ hang: true }, { text: "Recovered both." }]);
  const run = interactive([], workspace(), { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("Long turn."); run.type(KEY.enter); await run.waitFor(() => provider.requests.length === 1);
    for (const text of ["First pending.", "Second pending."]) { run.type(text); run.type(KEY.enter); }
    await run.waitFor(text => text.includes("2 messages en attente")); run.type(KEY.escape); await run.waitFor(text => text.includes("les envoyer maintenant ?"));
    await sleep(380); run.type("n"); await run.waitFor(() => run.screen().join("\n").includes("First pending.") && run.screen().join("\n").includes("Second pending.") && !run.screen().join("\n").includes("2 messages en attente"));
    expect(provider.requests).toHaveLength(1); expect(run.screen().join("\n")).not.toContain("2 messages en attente");
    run.type(KEY.enter); await run.waitFor(text => text.includes("Recovered both."));
    const last = provider.requests[1]!.history.filter(message => message.role === "user").at(-1);
    expect(JSON.stringify(last)).toContain("First pending.\\n\\nSecond pending.");
  } finally { controller.abort(); await run.done; }
}, 15_000);
