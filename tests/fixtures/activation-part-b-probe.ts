// Real module entry points in a compiled profile; no provider, vault or browser account is contacted.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FastOutput } from "../../src/providers/fast-output";
import { DEFAULT_CAPABILITIES, type ResolvedModel } from "../../src/providers/catalog";
import type { ModelProvider, ModelRequest } from "../../src/providers/types";
import { TurnAssistance } from "../../src/engine/turn-assistance";
import { ControlChannel } from "../../src/control/channel";
import { ControlSession } from "../../src/control/session";
import { parseControlMessage } from "../../src/control/protocol";
import { BrowserBridge } from "../../src/integrations/browser-bridge";
import { browserExtensionFiles, writeBrowserExtension } from "../../src/integrations/browser-extension";
import { runBrowserNativeHost } from "../../src/integrations/browser-native-host";
import { openPrivateStorage, privateStorageScope, storeRead, storeWrite } from "../../src/session/private-storage";

const root = mkdtempSync(join(import.meta.dir, "part-b-probe-"));
const failure = async (action: () => unknown | Promise<unknown>) => {
  try { await action(); return undefined; } catch (error) { return (error as Error).message; }
};
let eligibility = 0;
const fast = new FastOutput(async () => { eligibility++; return { eligible: true }; }, () => {});
const model: ResolvedModel = { id: "fixture", provider: "openai_compatible", family: "fixture", label: "Fixture", contextWindow: 1000, maxOutputTokens: 100, capabilities: DEFAULT_CAPABILITIES, currency: "USD", source: "distribution", providerOptions: { fastOutput: { value: "priority", multiplier: 2 } } };
const signal = new AbortController().signal;
const fastResult = await fast.set(true, model, signal);
let serviceOptions: unknown;
const provider: ModelProvider = { id: "fixture", async *stream(request) { serviceOptions = request.serviceOptions; } };
const request = { model, history: [], system: [], tools: [], maxOutputTokens: 1, thinking: { enabled: false, mode: "budget", budgetTokens: 0, showSummaries: false } } as ModelRequest;
for await (const _ of fast.wrap(provider).stream(request, signal)) { /* The observation is the request received by the provider. */ }
const purposes: string[] = [], summaries: string[] = [];
const assistance = new TurnAssistance({ now: Date.now, settings: () => ({ suggestions: false, recap: false, afterMs: 1, taskSummary: false, summaryEvery: 1, classify: false, jobWorkspace: false, progress: true, suppressed: false }), recent: () => "", redact: value => value, sample: async purpose => { purposes.push(purpose); return "Inspecter les fichiers."; }, suggestion: () => {}, recap: () => {}, state: () => {}, taskSummary: () => {}, progress: value => summaries.push(value) });
await assistance.tools(["read_file", "read_file"]); assistance.close();
const sent: unknown[] = [];
const channelError = await failure(() => {
  const channel = new ControlChannel({ send: message => sent.push(message), handlers: {}, defaultTimeoutMs: 1000, maxInFlight: 1, warn: () => {}, trace: () => {}, fatal: message => { throw Error(message); } });
  channel.sendInit("fixture"); channel.receive({ type: "control_init", protocolVersion: "1.0", demands: [] }); channel.close();
});
const sessionError = await failure(() => new ControlSession({ send: () => {}, defaultTimeoutMs: 1000, maxInFlight: 1, designationAccepted: false, allowEscalation: false, warn: () => {}, trace: () => {} }));
const parsed = parseControlMessage({ type: "control_init", protocolVersion: "1.0", demands: [], toolProgress: true });
let remembered = 0;
let bridge: BrowserBridge | undefined;
const bridgeError = await failure(() => { bridge = new BrowserBridge({ configDir: join(root, "browser-bridge"), slug: "fixture", product: "Fixture", extensionId: () => "a".repeat(32), permitted: () => true, changed: () => {}, remember: () => { remembered++; } }); });
await bridge?.close();
const browserFilesError = await failure(() => browserExtensionFiles("org.fixture.browser", "Fixture"));
const browserWriteError = await failure(() => writeBrowserExtension(join(root, "browser-files"), "fixture", "Fixture"));
const nativeHostError = await failure(() => runBrowserNativeHost([]));
const storageRoot = join(root, "storage"); mkdirSync(storageRoot); writeFileSync(join(storageRoot, "input-history.jsonl"), "private-probe\n");
const entries = new Map<string, string>(); let vaultReads = 0, vaultWrites = 0;
const vault = { read: (service: string, account: string) => { vaultReads++; return entries.get(service + account); }, write: (service: string, account: string, value: string) => { vaultWrites++; entries.set(service + account, value); }, remove: (service: string, account: string) => { entries.delete(service + account); } };
let decrypted: string | undefined;
const storageError = await failure(() => privateStorageScope(async () => { const close = await openPrivateStorage({ root: storageRoot, service: "fixture", vault, enabled: true }); try { const path = join(storageRoot, "input-history.jsonl"); storeWrite(path, Buffer.from("private-probe\n")); decrypted = storeRead(path).toString(); } finally { close(); } }));
const storageFiles = readdirSync(storageRoot);
const plaintext = storageFiles.includes("input-history.jsonl") ? readFileSync(join(storageRoot, "input-history.jsonl"), "utf8") : undefined;
const existing = join(root, "existing"); mkdirSync(join(existing, "archives-v1"), { recursive: true }); writeFileSync(join(existing, "archives-v1", "index"), "existing encrypted marker");
const existingError = await failure(() => privateStorageScope(() => openPrivateStorage({ root: existing, service: "fixture", vault, enabled: false })));
console.log(JSON.stringify({ fastResult, fastState: fast.state, eligibility, serviceOptions, purposes, summaries, channelError, sessionError, sent, parsed, remembered, bridgeError, browserFilesError, browserWriteError, nativeHostError, storageError, vaultReads, vaultWrites, storageFiles, plaintext, decrypted, existingError }));
