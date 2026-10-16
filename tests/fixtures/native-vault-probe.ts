// Supports: SPEC-SES-001/CA-06 (actual Secret Service and distinct OS accounts), gap E-234.
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync, chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { nativeCredentialVault } from "../../src/platform/credential-vault";
import { openArchiveKeys } from "../../src/session/archive-crypto";
import { cli, workspace, loadIdentity } from "../helpers/env";
import { ScriptedProvider } from "../helpers/scripted-provider";
import { dlopen } from "bun:ffi";
if (process.platform !== "linux" || Bun.version !== "1.4.2") throw Error("Native Linux Bun 1.4.2 required");
const base = process.env.WC_NATIVE_PROOF_DIR;
if (!base || !/^\/tmp\/whitecode-vault-proof-[a-zA-Z0-9]{6}$/.test(base)) throw Error("Owned proof directory required");
const receipt = join(base, "vault-public/receipt.json");
const vault = nativeCredentialVault({ interactive: process.argv[2] === "owner", environment: process.env as Record<string, string> });
const marker = "ARCHIVE_PROOF_WITHOUT_PLAINTEXT_" + crypto.randomUUID();
if (process.argv[2] === "owner") {
  if (process.getuid!() === 65534) throw Error("Owner identity missing");
  console.log("Native missing lookup:", await vault.read("whitecode-native60-sanity", "fixture") === undefined);
  await vault.write("whitecode-native60-sanity", "fixture", "synthetic-probe-value");
  console.log("Native write/read:", await vault.read("whitecode-native60-sanity", "fixture") === "synthetic-probe-value");
  await vault.remove("whitecode-native60-sanity", "fixture");
  const ws = workspace(), identity = loadIdentity(), service = identity.get("PRODUCT_SLUG") + ":archives";
  await openArchiveKeys({ service, configDir: ws.configHome, vault });
  const run = await cli(["--non-interactive", "Keep this session private"], ws, { provider: new ScriptedProvider([{ text: marker }]), userConfig: { storage: { encryption: { enabled: true } } }, extra: { credentialVault: vault } });
  if (run.code !== 0) throw Error(run.stderr);
  let found = false;
  const reopened = await cli(["--non-interactive", "--reopen-last", "Confirm previous text"], ws, { provider: new ScriptedProvider([request => { found = JSON.stringify(request.history).includes(marker); return { text: "Read encrypted history" }; }]), userConfig: { storage: { encryption: { enabled: true } } }, extra: { credentialVault: vault } });
  if (reopened.code !== 0 || !found) throw Error("Owner could not recover encrypted history: " + reopened.stderr);
  const publicRoot = join(base, "vault-public"), copy = join(publicRoot, "copy"); mkdirSync(publicRoot, { recursive: true, mode: 0o755 });
  cpSync(ws.configHome, copy, { recursive: true });
  let encrypted = 0;
  const exposeCiphertext = (directory: string) => { chmodSync(directory, 0o755); for (const entry of readdirSync(directory, { withFileTypes: true })) { const file = join(directory, entry.name); if (entry.isDirectory()) exposeCiphertext(file); else { const bytes = readFileSync(file); if (bytes.includes(Buffer.from(marker))) throw Error("Plaintext marker leaked"); if (bytes.toString("utf8", 0, 10) === "archive:1:") encrypted++; chmodSync(file, 0o644); } } };
  exposeCiphertext(copy); if (encrypted < 2) throw Error("Missing encrypted session files");
  const account = "profile-" + createHash("sha256").update(ws.configHome).digest("hex") + "-archives";
  if (typeof await vault.read(service, account) !== "string") throw Error("Real system vault did not retain archive key");
  // The common fixture directory contains software and ciphertext only; the private bus and test home stay 0700.
  chmodSync(base, 0o755);
  writeFileSync(receipt, JSON.stringify({ ownerUid: process.getuid!(), service, account, copy, encrypted, bus: process.env.DBUS_SESSION_BUS_ADDRESS }), { mode: 0o644 });
  console.log("Owner CLI encrypted and reopened its history; ciphertext copy ready.");
  const deadline = Date.now() + 90000;
  const resultFile = join(publicRoot, "foreign-result.json");
  while (!Bun.file(resultFile).size && Date.now() < deadline) await Bun.sleep(100);
  const foreign = await Bun.file(resultFile).json();
  if (!foreign.refused || foreign.uid === process.getuid!()) throw Error("Foreign account isolation failed");
  console.log(JSON.stringify({ ownerUid: process.getuid!(), encrypted, foreign }));
} else {
  if (process.getuid!() !== 65534) throw Error("A real different OS identity is required");
  // Prove the other account can load the real client library; missing software must never masquerade as vault isolation.
  const nativeLibrary = dlopen("libsecret-1.so.0", { secret_service_get_type: { args: [], returns: "u64" } });
  if (!nativeLibrary.symbols.secret_service_get_type()) throw Error("Native Secret Service library unavailable to the foreign account");
  const facts = JSON.parse(readFileSync(receipt, "utf8")), own = mkdtempSync("/tmp/whitecode-foreign60-");
  cpSync(facts.copy, join(own, "copy"), { recursive: true });
  let refused = false, lookupRefused = false;
  try { const existing = await vault.read(facts.service, facts.account); lookupRefused = existing === undefined; } catch { lookupRefused = true; }
  if (!lookupRefused) throw Error("Other OS user accessed the owner's vault key");
  try { await openArchiveKeys({ service: facts.service, configDir: join(own, "copy"), vault, requireExisting: true }); } catch { refused = true; }
  if (!refused) throw Error("Other OS user opened the encrypted copy");
  console.log(JSON.stringify({ uid: process.getuid!(), nativeLibraryLoaded: true, copiedReadable: readdirSync(join(own, "copy")).length > 0, lookupRefused, refused }));
}
