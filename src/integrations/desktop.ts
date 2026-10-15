// Implements: SPEC-CMD-019, SPEC-INT-012 (acknowledged desktop handoff with complete neutral history), gap E-211.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPrivateText } from "../shared/private-text";
import { ownedByCurrentUser } from "../platform/private-file";
import { processExists } from "../platform/process";
import { residentRequest } from "../services/transport";
import type { HistoryMessage } from "../providers/types";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** The desktop application writes this owner-only registration while its local receiver is alive. */
export function desktopRegistration(
  configDir: string,
): { port: number; pid: number; token: string } | undefined {
  const file = join(configDir, "desktop", "instance.json");
  if (!existsSync(file)) return;
  try {
    if (!ownedByCurrentUser(file)) return;
    const raw: unknown = JSON.parse(readPrivateText(file, 4096));
    if (
      !object(raw) ||
      raw.version !== 1 ||
      !Number.isSafeInteger(raw.pid) ||
      Number(raw.pid) < 1 ||
      !processExists(Number(raw.pid)) ||
      !Number.isSafeInteger(raw.port) ||
      Number(raw.port) < 1 ||
      Number(raw.port) > 65535 ||
      typeof raw.token !== "string" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(raw.token) ||
      typeof raw.updatedAt !== "number" ||
      raw.updatedAt < Date.now() - 120000 ||
      raw.updatedAt > Date.now() + 30000 ||
      !ownedByCurrentUser(file)
    )
      return;
    return { port: Number(raw.port), pid: Number(raw.pid), token: raw.token };
  } catch {
    return;
  }
}
export async function transferToDesktop(o: {
  configDir: string;
  slug: string;
  sessionId: string;
  cwd: string;
  history: () => readonly HistoryMessage[];
  redact: (value: string) => string;
  flush: () => void;
  open: (url: string) => boolean;
  signal: AbortSignal;
  assertPolicy: () => void;
  timeoutMs?: number;
}): Promise<boolean> {
  o.assertPolicy();
  o.signal.throwIfAborted();
  const endpoint = desktopRegistration(o.configDir);
  if (!endpoint) return false;
  const neutral = () =>
    JSON.parse(
      o.redact(
        JSON.stringify(
          o.history().map((message) =>
            message.role === "assistant"
              ? {
                  role: message.role,
                  text: message.text,
                  toolCalls: message.toolCalls,
                }
              : message,
          ),
        ),
      ),
    );
  const history = neutral(),
    digest = createHash("sha256").update(JSON.stringify(history)).digest("hex"),
    id = randomUUID();
  const payload = {
    version: 1,
    id,
    sessionId: o.sessionId,
    cwd: o.cwd,
    history,
    digest,
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 8 * 1024 * 1024)
    throw Error(
      "Historique trop volumineux pour le transfert local ; session conservée.",
    );
  o.flush();
  const lifetime = AbortSignal.any([
    o.signal,
    AbortSignal.timeout(o.timeoutMs ?? 15000),
  ]);
  const call = (path: string, body: unknown) =>
    residentRequest(endpoint, "/desktop/" + path, body, lifetime);
  const prepared = await call("prepare", payload);
  if (
    prepared.id !== id ||
    prepared.sessionId !== o.sessionId ||
    prepared.digest !== digest ||
    prepared.status !== "prepared"
  )
    throw Error(
      "L’application n’a pas confirmé la préparation de l’historique ; session conservée.",
    );
  o.assertPolicy();
  lifetime.throwIfAborted();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(o.slug))
    throw Error("Protocole de bureau invalide.");
  const url = new URL(
    `${o.slug}-desktop://session/${encodeURIComponent(o.sessionId)}`,
  );
  url.searchParams.set("transfer", id);
  url.searchParams.set("cwd", o.cwd);
  if (!o.open(url.href))
    throw Error("Ouverture de l’application impossible ; session conservée.");
  for (;;) {
    o.assertPolicy();
    lifetime.throwIfAborted();
    const status = await call("status", { id });
    if (
      status.id !== id ||
      status.sessionId !== o.sessionId ||
      status.digest !== digest
    )
      throw Error("Accusé de transfert invalide ; session conservée.");
    if (status.status === "opened") {
      if (
        createHash("sha256").update(JSON.stringify(neutral())).digest("hex") !==
        digest
      )
        throw Error(
          "La conversation a changé pendant le transfert ; recommencez depuis le terminal conservé.",
        );
      o.flush();
      return true;
    }
    if (status.status !== "prepared")
      throw Error("Transfert refusé par l’application ; session conservée.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        lifetime.removeEventListener("abort", abort);
        resolve();
      }, 150);
      const abort = () => {
        clearTimeout(timer);
        reject(Error("Transfert non confirmé ; session conservée."));
      };
      lifetime.addEventListener("abort", abort, { once: true });
      if (lifetime.aborted) abort();
    });
  }
}
