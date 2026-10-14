import { expect, test } from "bun:test";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-AGT-023/CA-01 — a live workflow panel shows both parallel steps and their actual agents, with partial and total stop", async () => {
  const ws = workspace();
  ws.write("home/config/workflows/tree.yaml", JSON.stringify({ name: "tree", description: "Observe two parallel agents.", maxParallel: 2, steps: ["first", "second"].map(id => ({ id, type: "agent", prompt: `WAIT_TREE_${id}`, onError: "continue" })) }));
  const active = new Set<string>(), aborted = new Set<string>();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_workflow", input: { workflow: "tree" } }] }, { text: "TREE_PARENT_READY" }], [{ hang: true }, { hang: true }]);
  const stream = provider.stream.bind(provider);
  provider.stream = async function* (request, signal) {
    if (request.purpose !== "subagent") { yield* stream(request, signal); return; }
    active.add(request.agent!); signal.addEventListener("abort", () => { aborted.add(request.agent!); }, { once: true });
    try { yield* stream(request, signal); } finally { active.delete(request.agent!); }
  };
  const controller = new AbortController(), run = interactive(["--allow-rule", "run_workflow(tree)"], ws, { provider, signal: controller.signal });
  const openDetail = async () => { run.type("\u001bk"); await run.waitFor(text => text.includes("Tâches de fond — choisir")); await sleep(380); run.type(KEY.enter); await run.waitFor(text => text.includes("Détail de w1")); };
  try {
    await run.idle(); run.type("Run the workflow.\r"); await run.waitFor(text => text.includes("TREE_PARENT_READY"));
    const deadline = Date.now() + 5000; while (active.size < 2 && Date.now() < deadline) await sleep(10);
    expect(active.size).toBe(2); const ids = [...active];
    await openDetail(); const screen = run.screen().join("\n");
    expect(screen).toContain("first"); expect(screen).toContain("second"); for (const id of ids) expect(screen).toContain(id);
    await sleep(380); run.type(KEY.down); run.type(KEY.down); run.type(KEY.enter);
    await run.waitFor(text => text.includes("Arrêter l’agent")); await sleep(380); run.type("o");
    await run.waitFor(text => text.includes("Agent") && text.includes("arrêté."));
    expect(aborted.size).toBe(1); expect(active.size).toBe(1);
    await openDetail(); expect(run.screen().join("\n")).toContain("failed");
    await sleep(380); run.type(KEY.down); run.type(KEY.enter); await run.waitFor(text => text.includes("Arrêter la tâche w1"));
    await sleep(380); run.type("o"); await run.waitFor(text => text.includes("Tâche w1 arrêtée"));
    expect(aborted.size).toBe(2); expect(active.size).toBe(0);
  } finally { controller.abort(); await run.done; }
}, 20_000);
