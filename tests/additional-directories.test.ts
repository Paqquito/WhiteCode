import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-PER-011/CA-01 — the explicit neighboring directory permits a model read without approval", async () => {
  const ws = workspace(), path = ws.write("neighbor/witness.txt", "ADDITIONAL_DIRECTORY_WITNESS");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, request => { expect(JSON.stringify(request.history)).toContain("ADDITIONAL_DIRECTORY_WITNESS"); return { text: "Read completed" }; }]);
  const result = await cli(["--non-interactive", "--allow-dir", path.replace(/[\\/]witness.txt$/, ""), "Read neighbor"], ws, { provider });
  expect(result.code).toBe(0); expect(result.stdout).toContain("Read completed");
});
test("SPEC-PER-011/CA-02 — the entire home requires a reinforced confirmation before addition and a refusal can be retried", async () => {
  const ws = workspace(), path = ws.write("home/witness.txt", "HOME_DIRECTORY_WITNESS");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, request => { expect(JSON.stringify(request.history)).toContain("HOME_DIRECTORY_WITNESS"); return { text: "HOME_READ_COMPLETE" }; }]);
  const run = interactive([], ws, { provider });
  try {
    await run.waitFor(text => text.includes("test-medium"));
    run.type(`/allow-dir ${ws.home}`); run.type(KEY.enter);
    await run.waitFor(text => text.includes("Confirmer cet accès étendu"));
    await sleep(400); run.type("n");
    await run.waitFor(text => text.includes("Ajout abandonné"));
    run.type(`/allow-dir ${ws.home}`); run.type(KEY.enter);
    await run.waitFor(text => text.includes("Confirmer cet accès étendu"));
    await sleep(400); run.type("o");
    await run.waitFor(text => text.includes("Dossier ajouté pour la session"));
    run.type("Read home witness"); run.type(KEY.enter);
    await run.waitFor(text => text.includes("HOME_READ_COMPLETE"));
    run.type("/quit"); run.type(KEY.enter); expect((await run.done).code).toBe(0);
  } finally { if (!run.finished()) { run.type(KEY.ctrlC); run.type(KEY.ctrlC); } }
}, 15000);
