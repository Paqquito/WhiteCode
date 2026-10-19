// Supports: SPEC-INT-011 (current-user native host registration and bounded binary native-messaging frames).
import { dlopen } from "bun:ffi";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { endianness } from "node:os";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { ownedByCurrentUser, restrictFileToOwner, securePrivateDirectory } from "./private-file";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "./system";
import { productProcess } from "./product-process";
import { runToCompletion } from "./process";

export interface BrowserHost { readonly directory: string; readonly host: string; readonly extensionId: string; readonly manifest: string; readonly wrapper: string }
export const browserHostName = (slug: string) => { if (!/^[a-z][a-z0-9-]{0,63}$/.test(slug)) throw Error("Invalid product browser host."); return slug.replaceAll("-", "_") + ".browser"; };
function systemRoot(): string { const api = dlopen("kernel32.dll", { GetWindowsDirectoryW: { args: ["buffer", "u32"], returns: "u32" } }); try { const bytes = Buffer.alloc(65536), count = api.symbols.GetWindowsDirectoryW(bytes, 32768); if (!count || count >= 32768) throw Error("Windows system directory unavailable."); return bytes.subarray(0, count * 2).toString("utf16le"); } finally { api.close(); } }
export function browserPrivateDirectory(configDir: string): string {
  if (!isAbsolute(configDir)) throw Error("Absolute browser configuration directory required."); const directory = join(resolve(configDir), "browser"); ordinaryPrivateFile(join(directory, "guard"), 1); mkdirSync(directory, { recursive: true, mode: 0o700 }); securePrivateDirectory(directory); return directory;
}
export function privateBrowserText(path: string, limit = 8192): string { ordinaryPrivateFile(path, limit); if (!ownedByCurrentUser(path)) throw Error("Browser state belongs to another system user."); restrictFileToOwner(path); const text = readPrivateText(path, limit); if (!ownedByCurrentUser(path)) throw Error("Browser state ownership changed."); return text; }
const registryKey = (browser: "chrome" | "edge", host: string) => `HKCU\\Software\\${browser === "chrome" ? "Google\\Chrome" : "Microsoft\\Edge"}\\NativeMessagingHosts\\${host}`;
/** Never replaces another application's registry value. The returned cleanup removes only new, still-matching keys. */
export function installBrowserHost(configDir: string, slug: string, extensionId: string): BrowserHost & { removeNewRegistrations(): void } {
  if (process.platform !== "win32") throw Error("Native browser host installation currently requires Windows.");
  if (!/^[a-p]{32}$/.test(extensionId)) throw Error("An exact installed browser extension identifier is required.");
  const directory = browserPrivateDirectory(configDir), host = browserHostName(slug), manifest = join(directory, "native-host.json"), wrapper = join(directory, "native-host.cmd"), registration = join(directory, "host-registration.json");
  const program = productProcess(["--browser-native-host", resolve(configDir), host, extensionId]); if (program.args[0] && /\.(?:m?js|ts)$/.test(program.args[0])) program.args.unshift("--no-env-file");
  const quote = (value: string) => { if (!value || /[^\x20-\x7e]|["%!?&|<>^]/.test(value)) throw Error("This native host launcher requires ordinary ASCII paths without command metacharacters."); return '"' + value + '"'; };
  const script = "@echo off\r\n@" + [program.file, ...program.args].map(quote).join(" ") + " %*\r\n", native = { name: host, description: "User-approved browser bridge", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, info: BrowserHost & { version: number } = { version: 1, directory, host, extensionId, manifest, wrapper };
  const windows = systemRoot(), executable = join(windows, "System32/reg.exe"), env = { SystemRoot: windows, PATH: join(windows, "System32") }, keys = [registryKey("chrome", host), registryKey("edge", host)], created: string[] = [];
  const query = (key: string) => { const result = runToCompletion(executable, ["query", key, "/ve"], { cwd: directory, env, timeoutMs: 3000 }); if (result.code === 1) return undefined; if (result.code !== 0) throw Error("Browser native host registry unavailable."); const value = /REG_SZ\s+([^\r\n]+)/.exec(result.stdout)?.[1]?.trim(); if (!value) throw Error("Invalid browser native host registry value."); return value; };
  for (const key of keys) { const existing = query(key); if (existing !== undefined && existing.toLowerCase() !== manifest.toLowerCase()) throw Error("Another native host registration already uses this product name."); }
  if (existsSync(registration)) { const previous = JSON.parse(privateBrowserText(registration)); if (previous.host !== host || previous.directory !== directory || previous.manifest !== manifest || previous.wrapper !== wrapper) throw Error("Native browser registration has another identity."); }
  for (const file of [manifest, wrapper, registration]) { ordinaryPrivateFile(file, 65536); if (existsSync(file) && !ownedByCurrentUser(file)) throw Error("Native host file belongs to another user."); }
  writeAtomic(wrapper, Buffer.from(script, "ascii"), currentPlatform(), true); writeAtomic(manifest, Buffer.from(JSON.stringify(native)), currentPlatform(), true); writeAtomic(registration, Buffer.from(JSON.stringify(info)), currentPlatform(), true);
  const cleanup = () => { for (const key of created) { if (query(key)?.toLowerCase() !== manifest.toLowerCase()) throw Error("Native host registry changed; cleanup refused."); const result = runToCompletion(executable, ["delete", key, "/f"], { cwd: directory, env, timeoutMs: 3000 }); if (result.code !== 0) throw Error("Native host registry cleanup failed."); } created.length = 0; };
  try { for (const key of keys) { if (query(key) !== undefined) continue; const result = runToCompletion(executable, ["add", key, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { cwd: directory, env, timeoutMs: 3000 }); if (result.code !== 0) throw Error("Native host registration failed."); created.push(key); if (query(key)?.toLowerCase() !== manifest.toLowerCase()) throw Error("Native host registration was not confirmed."); } }
  catch (error) { cleanup(); throw error; }
  return { ...info, removeNewRegistrations: cleanup };
}
export async function* nativeBrowserMessages(input: AsyncIterable<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  let buffer = Buffer.alloc(0); for await (const chunk of input) { if (buffer.length + chunk.length > 2097152) throw Error("Native browser input exceeds its bound."); buffer = Buffer.concat([buffer, chunk]); for (;;) { if (buffer.length < 4) break; const size = endianness() === "LE" ? buffer.readUInt32LE() : buffer.readUInt32BE(); if (size < 2 || size > 1048576) throw Error("Invalid native browser frame size."); if (buffer.length < size + 4) break; const frame: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4, size + 4))); buffer = buffer.subarray(size + 4); if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw Error("Invalid native browser message."); yield frame as Record<string, unknown>; } } if (buffer.length) throw Error("Truncated native browser message.");
}
export function nativeBrowserWrite(value: unknown): void { const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > 1048576) throw Error("Native browser output exceeds its bound."); const header = Buffer.alloc(4); if (endianness() === "LE") header.writeUInt32LE(bytes.length); else header.writeUInt32BE(bytes.length); process.stdout.write(Buffer.concat([header, bytes])); }
