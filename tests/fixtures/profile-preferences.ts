// Native macOS fixture: only ordinary user preferences in a fresh, owned application domain are written.
// No configuration profile or real managed policy is installed, removed or changed.
import { dlopen } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, ROOT, workspace } from "../helpers/env";
import { ScriptedProvider } from "../helpers/scripted-provider";
import { readMacManagedProfile } from "../../src/platform/managed-profile";
import { Identity } from "../../src/identity/identity";
import { resolveIdentity } from "../../src/identity/resolver";

const domain = `example.profile-fixture.${randomUUID()}`;
if (!/^example\.profile-fixture\.[0-9a-f-]{36}$/.test(domain)) throw new Error("Unsafe preference fixture domain");
const UTF8 = 0x08000100;
const api = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
  CFStringCreateWithCString: { args: ["ptr", "buffer", "u32"], returns: "ptr" },
  CFPreferencesSetAppValue: { args: ["ptr", "ptr", "ptr"], returns: "void" },
  CFPreferencesCopyAppValue: { args: ["ptr", "ptr"], returns: "ptr" },
  CFPreferencesAppSynchronize: { args: ["ptr"], returns: "bool" },
  CFPreferencesAppValueIsForced: { args: ["ptr", "ptr"], returns: "bool" },
  CFStringGetCString: { args: ["ptr", "buffer", "i64", "u32"], returns: "bool" },
  CFRelease: { args: ["ptr"], returns: "void" },
});
const native = api.symbols;
const string = (text: string) => {
  const result = native.CFStringCreateWithCString(null, Buffer.from(`${text}\0`, "utf8"), UTF8);
  if (!result) throw new Error("Preference fixture string creation failed");
  return result;
};
const application = string(domain);
const key = string("Policy");
const sync = () => { if (!native.CFPreferencesAppSynchronize(application)) throw new Error("Preference fixture synchronisation failed"); };
let written = false;
try {
  sync();
  if (native.CFPreferencesAppValueIsForced(key, application)) throw new Error("Unexpected managed fixture domain");
  const absent = readMacManagedProfile(domain);
  const ordinaryText = JSON.stringify({ permissions: { denyRules: ["read_file"] }, ui: { announcements: ["Résumé — 日本語 🧪"] } });
  const value = string(ordinaryText);
  try { native.CFPreferencesSetAppValue(key, value, application); written = true; sync(); }
  finally { native.CFRelease(value); }
  const copy = native.CFPreferencesCopyAppValue(key, application);
  if (!copy) throw new Error("Ordinary preference fixture missing");
  try {
    const bytes = Buffer.alloc(4096);
    if (!native.CFStringGetCString(copy, bytes, bytes.length, UTF8) || bytes.subarray(0, bytes.indexOf(0)).toString("utf8") !== ordinaryText) throw new Error("Ordinary preference fixture roundtrip failed");
  } finally { native.CFRelease(copy); }
  const ordinaryForced = native.CFPreferencesAppValueIsForced(key, application);
  const ordinary = readMacManagedProfile(domain);
  const seed = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
  const resolved = resolveIdentity({ ...seed, identity: { ...seed.identity, PRODUCT_BUNDLE_ID: domain } }, { version: "0.1.0" });
  if (!resolved.identity) throw new Error("Invalid fixture identity");
  const identity = new Identity(resolved.identity);
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  const provider = new ScriptedProvider([]);
  const preferences = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { identity, provider });
  const validation = await cli(["config", "validate", "--json"], ws, { identity, provider });
  const invalidDomain = readMacManagedProfile("bad/domain");
  console.log(JSON.stringify({ absent, ordinary, ordinaryForced, preferences, validation, invalidDomain, requests: provider.requests.length }));
} finally {
  try { if (written) { native.CFPreferencesSetAppValue(key, null, application); sync(); } }
  finally { native.CFRelease(key); native.CFRelease(application); api.close(); }
}
