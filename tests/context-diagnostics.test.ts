import { profiledTest } from "./helpers/profiled-test";
import { expect } from "bun:test";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
const internalProfileTest = profiledTest(import.meta.path, "internal");

{
  const test = internalProfileTest;
test("SPEC-CMD-089/CA-01 — an API key is masked, and uncatalogued variables are absent", async () => {
  const prefix = loadIdentity().get("ENV_PREFIX");
  const r = await cli(["--non-interactive", "/env"], workspace(), { provider: new ScriptedProvider([]), env: { OPENAI_API_KEY: "opaque_fixture_value_291", [`${prefix}MODEL_DEFAULT`]: "medium", UNCATALOGUED_WITNESS: "private_unlisted_value" } });
  expect(r.code).toBe(0); expect(r.stdout).toContain("OPENAI_API_KEY = ••••");
  expect(r.stdout).toContain(`${prefix}MODEL_DEFAULT = medium`); expect(r.stdout).not.toContain("opaque_fixture_value_291"); expect(r.stdout).not.toContain("private_unlisted_value");
});
}


{
  const test = internalProfileTest;
test("SPEC-CMD-087/CA-01 — every attached file appears as its own sized block, without another model request", async () => {
  const ws = workspace(); const paths = [ws.write("project/a", "FIRST_FILE_WITNESS"), ws.write("project/b", "SECOND_FILE_WITNESS")];
  const provider = new ScriptedProvider([{ text: "read received" }]); const host = new Host(ws, { provider });
  try {
    host.user(paths.map(path => `@${path}`).join(" ")); await host.waitFor(message => message.type === "turn_completed");
    const result = await host.request("invoke_command", { command: "/context-debug" });
    expect(JSON.stringify(result)).toContain("Pièce jointe");
    const report = String((result.result as { shown: string }).shown);
    expect(report).toMatch(/Pièce jointe : a — \d+ octets/); expect(report).toMatch(/Pièce jointe : b — \d+ octets/);
    expect(report).toContain("octets"); expect(report).not.toContain("FIRST_FILE_WITNESS"); expect(report).not.toContain("SECOND_FILE_WITNESS");
    expect(provider.requests).toHaveLength(1);
  } finally { host.feed.end(); await host.run; }
});
}
