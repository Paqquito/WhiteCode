// Native Windows fixture: HKLM is redirected within this child process to a newly owned HKCU subtree.
// No machine policy is written, and the parent test process keeps its original registry view.
import { dlopen } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { cli, loadIdentity, workspace } from "../helpers/env";
import { Host } from "../helpers/control";
import { interactive, KEY } from "../helpers/interactive";
import { ScriptedProvider } from "../helpers/scripted-provider";
import { readWindowsRegistryPolicy } from "../../src/platform/registry";

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
const machine = 0xffffffff80000002n;
const user = 0xffffffff80000001n;
const ownedPath = `Software\\RegistryFixture-${randomUUID()}`;
const api = dlopen("advapi32.dll", {
  RegCreateKeyExW: { args: ["u64", "buffer", "u32", "ptr", "u32", "u32", "ptr", "buffer", "buffer"], returns: "i32" },
  RegSetValueExW: { args: ["u64", "buffer", "u32", "u32", "buffer", "u32"], returns: "i32" },
  RegOverridePredefKey: { args: ["u64", "u64"], returns: "i32" },
  RegCloseKey: { args: ["u64"], returns: "i32" },
  RegDeleteTreeW: { args: ["u64", "buffer"], returns: "i32" },
  RegDeleteKeyExW: { args: ["u64", "buffer", "u32", "u32"], returns: "i32" },
});
const native = api.symbols;
const checked = (code: number) => { if (code !== 0) throw new Error(`Registry fixture failed: ${code}`); };
const create = (root: bigint, path: string) => {
  const handle = Buffer.alloc(8);
  checked(native.RegCreateKeyExW(root, wide(path), 0, null, 0, 0xf003f | 0x100, null, handle, Buffer.alloc(4)));
  return handle.readBigUInt64LE();
};
let root: bigint | undefined;
let policy: bigint | undefined;
let redirected = false;
try {
  root = create(user, ownedPath);
  const key = loadIdentity().get("MANAGED_REGISTRY_KEY").replace(/\\+/g, "\\");
  policy = create(root, key);
  const set = (text: string, type = 1) => { const bytes = wide(text); checked(native.RegSetValueExW(policy!, wide("Policy"), 0, type, bytes, bytes.length)); };
  set(JSON.stringify({ ui: { history: { maxEntries: 456 }, announcements: ["Résumé — 日本語"] } }));
  checked(native.RegOverridePredefKey(machine, root));
  redirected = true;
  const source = readWindowsRegistryPolicy(key);
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  const preferences = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws);
  const validation = await cli(["config", "validate", "--json"], ws);
  const provider = new ScriptedProvider([]);
  const host = new Host(ws, { provider, init: { decisionAuthority: true }, userConfig: { engine: { control: { allowEscalation: true } } }, answers: { confirm_escalation: (params) => ({ decision: "confirm", escalationId: params["escalationId"] }) } });
  const before = await host.request("invoke_command", { command: "/preferences ui.history.maxEntries" });
  set(JSON.stringify({ ui: { history: { maxEntries: 654 } } }));
  const after = await host.request("invoke_command", { command: "/preferences ui.history.maxEntries" });
  host.feed.end();
  const control = await host.finish();
  const terminal = interactive([], ws, { provider });
  await terminal.idle();
  terminal.type("/preferences ui.history.maxEntries" + KEY.enter);
  await terminal.waitFor((text) => text.includes("654"), "managed registry value");
  terminal.type("/quit" + KEY.enter);
  const terminalResult = await terminal.done;
  set(JSON.stringify({ permissions: { denyRules: ["read_file"] } }));
  const mandatory = readWindowsRegistryPolicy(key);
  set("{}\0{}");
  const embeddedNull = readWindowsRegistryPolicy(key);
  set("x".repeat(524_289));
  const tooLarge = readWindowsRegistryPolicy(key);
  set("123", 4); // REG_DWORD is rejected instead of falling back to the file.
  const wrongType = await cli(["--non-interactive", "Read the summary."], ws, { provider });
  console.log(JSON.stringify({ source, preferences, validation, before, after, control, terminalResult, mandatory, embeddedNull, tooLarge, wrongType, requests: provider.requests.length }));
} finally {
  if (redirected) checked(native.RegOverridePredefKey(machine, 0n));
  if (policy !== undefined) checked(native.RegCloseKey(policy));
  if (root !== undefined) checked(native.RegCloseKey(root));
  if (!/^Software\\RegistryFixture-[0-9a-f-]{36}$/.test(ownedPath)) throw new Error("Unsafe registry fixture path");
  if (root !== undefined) {
    checked(native.RegDeleteTreeW(user, wide(ownedPath)));
    const deleted = native.RegDeleteKeyExW(user, wide(ownedPath), 0x100, 0);
    if (deleted !== 2) checked(deleted);
  }
  api.close();
}
