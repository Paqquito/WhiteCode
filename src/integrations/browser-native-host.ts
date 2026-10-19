// Supports: SPEC-INT-011 (real native messaging host, exact extension origin and authenticated per-user bridge).
import { isAbsolute, join, resolve } from "node:path";
import { nativeBrowserMessages, nativeBrowserWrite, privateBrowserText } from "../platform/browser-native";
import { residentFetch } from "../platform/resident-process";
import { residentRequest } from "../services/transport";
import { processExists } from "../platform/process";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export async function runBrowserNativeHost(args: readonly string[]): Promise<void> {
  const [configDir, host, extensionId, origin, ...extra] = args;
  if (!configDir || !isAbsolute(configDir) || !host || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(host) || !extensionId || !/^[a-p]{32}$/.test(extensionId) || ![`chrome-extension://${extensionId}`, `chrome-extension://${extensionId}/`].includes(origin ?? "") || extra.some(value => !/^--parent-window=[0-9]+$/.test(value))) throw Error("Invalid browser native host identity.");
  const directory = join(resolve(configDir), "browser"), registration: unknown = JSON.parse(privateBrowserText(join(directory, "host-registration.json")));
  if (!object(registration) || registration.version !== 1 || registration.directory !== directory || registration.host !== host || registration.extensionId !== extensionId) throw Error("Browser native host registration changed.");
  const readEndpoint = () => { const value: unknown = JSON.parse(privateBrowserText(join(directory, "endpoint.json"))); if (!object(value) || value.version !== 1 || value.extensionId !== extensionId || value.host !== host || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535 || !Number.isSafeInteger(value.pid) || !processExists(Number(value.pid)) || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || value.updatedAt < Date.now() - 15000 || value.updatedAt > Date.now() + 30000) throw Error("Browser session is not active."); return { id: value.id, port: Number(value.port), pid: Number(value.pid), token: value.token }; };
  const endpoint = readEndpoint(), life = new AbortController(), scope = life.signal;
  const call = async (path: string, body: unknown) => { const current = readEndpoint(); if (JSON.stringify(current) !== JSON.stringify(endpoint)) throw Error("Browser session changed."); return residentRequest(endpoint, "/browser/" + path, body, AbortSignal.any([scope, AbortSignal.timeout(5000)])); };
  const messages = nativeBrowserMessages(process.stdin); let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([messages.next(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error("Browser extension handshake timed out.")), 5000); timer.unref(); })]).finally(() => clearTimeout(timer));
  if (first.done || first.value.type !== "hello" || first.value.version !== 1 || !["Chrome", "Edge"].includes(String(first.value.browser))) throw Error("Invalid browser extension handshake.");
  const attached = await call("attach", { browser: first.value.browser, extensionId }); if (typeof attached.client !== "string" || !/^[a-f0-9-]{36}$/.test(attached.client)) throw Error("Invalid native browser lease.");
  const close = () => life.abort(); process.on("SIGTERM", close); process.on("SIGINT", close);
  const pump = async () => { for await (const message of messages) { scope.throwIfAborted(); if (typeof message.id !== "string" || !/^[a-f0-9-]{36}$/.test(message.id) || !object(message.result) && typeof message.error !== "string") throw Error("Invalid native browser tool response."); await call("result", { ...message, client: attached.client }); } };
  const poll = async () => { while (!scope.aborted) { const next = await call("poll", { client: attached.client }); if (next.command !== undefined) { if (!object(next.command) || typeof next.command.id !== "string" || !object(next.command.input)) throw Error("Invalid browser command."); nativeBrowserWrite(next.command); } else await new Promise<void>(resolve => setTimeout(resolve, 50)); } };
  try { await Promise.race([pump(), poll()]); }
  finally { life.abort(); process.removeListener("SIGTERM", close); process.removeListener("SIGINT", close); await residentFetch(endpoint.port, endpoint.token, "/browser/detach", { client: attached.client }, AbortSignal.timeout(1000)).then(response => response.body?.cancel()).catch(() => {}); }
}
