import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { BUN } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { ProviderError } from "../src/providers/types";

const diskText = (root: string): string => readdirSync(root, { withFileTypes: true }).map(entry => entry.isDirectory() ? diskText(join(root, entry.name)) : readFileSync(join(root, entry.name), "utf8")).join("\n");
function fixture() {
  const ws = workspace(), count = join(ws.root, "count"), used: string[] = [];
  const file = ws.write("helper.ts", `const fs = await import("node:fs"); const path = ${JSON.stringify(count)}; const n = fs.existsSync(path) ? Number(fs.readFileSync(path,"utf8"))+1 : 1; fs.writeFileSync(path,String(n)); console.log("fixture-credential-" + process.pid + "-" + n);`);
  return { ws, count, used, userConfig: { auth: { credentialHelper: `"${BUN}" "${file.replace(/\\/g, "/")}"` } } };
}
test("SPEC-API-014/CA-01 — the configured helper supplies the actual entrypoint without persisting or displaying its value", async () => {
  const f = fixture();
  const result = await cli(["--non-interactive", "Work"], f.ws, { userConfig: f.userConfig, extra: { providerFactory: options => {
    f.used.push(options.apiKey!); const provider = new ScriptedProvider([{ text: options.apiKey! }]);
    return { id: provider.id, async *stream(request, signal) { for await (const event of provider.stream(request, signal)) {
      if (event.type === "text_delta") { for (const text of event.text.match(/.{1,3}/gs)!) yield { type: "text_delta" as const, text }; }
      else yield event.type === "message_complete" ? { ...event, assistant: { ...event.assistant, native: { provider: "fixture", content: { [options.apiKey!]: options.apiKey } } } } : event;
    } } };
  } } });
  expect(result.code).toBe(0); expect(f.used).toHaveLength(1); expect(f.used[0]).toStartWith("fixture-credential-"); expect(readFileSync(f.count, "utf8")).toBe("1");
  expect(result.stdout).toContain("redacted credential"); expect(result.stdout + result.stderr + diskText(f.ws.root)).not.toContain(f.used[0]!);
});
test("TECH — a second authentication rejection never executes the helper a third time", async () => {
  const f = fixture();
  const result = await cli(["--non-interactive", "Work"], f.ws, { userConfig: { ...f.userConfig, api: { maxRetries: 0 } }, extra: { providerFactory: () => ({ id: "fixture", async *stream() { throw new ProviderError("authentication", "still rejected", 401); } }) } });
  expect(result.code).not.toBe(0); expect(readFileSync(f.count, "utf8")).toBe("2");
});
test("TECH — an approved project cannot provide an executable credential helper", async () => {
  const f = fixture(); f.ws.write(`project/${loadIdentity().get("PROJECT_DIR")}/config.json`, JSON.stringify(f.userConfig));
  const result = await cli(["--non-interactive", "--allow-project-trust", "Work"], f.ws, { provider: new ScriptedProvider([{ text: "PROJECT_HELPER_IGNORED" }]) });
  expect(result.code).toBe(0); expect(result.stdout).toContain("PROJECT_HELPER_IGNORED"); expect(result.stderr).toContain("auth.credentialHelper");
  expect(existsSync(f.count)).toBe(false);
});
test("SPEC-API-014/CA-02 — authentication rejection refreshes once through the actual request loop", async () => {
  const f = fixture();
  const result = await cli(["--non-interactive", "Work"], f.ws, { userConfig: f.userConfig, extra: { providerFactory: options => { f.used.push(options.apiKey!); return f.used.length === 1 ? { id: "fixture", async *stream() { throw new ProviderError("authentication", "synthetic rejection", 401); } } : new ScriptedProvider([{ text: "renewed" }]); } } });
  expect(result.code).toBe(0); expect(result.stdout).toContain("renewed"); expect(f.used).toHaveLength(2); expect(f.used[1]).not.toBe(f.used[0]); expect(readFileSync(f.count, "utf8")).toBe("2");
  for (const value of f.used) expect(result.stdout + result.stderr + diskText(f.ws.root)).not.toContain(value);
});
