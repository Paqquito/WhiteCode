// Implements: SPEC-AGT-008/CA-01 (bounded version, explicit replace/ignore and concurrent-memory guard), gap E-197.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { MemoryStore } from "../memory/store";
import { readPrivateText } from "../shared/private-text";
import { storeExists } from "../session/private-storage";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export async function offerMemorySnapshot(o: {
  snapshot: string;
  memory: MemoryStore;
  interactive: boolean;
  denied: (path: string) => boolean;
  confirm: (question: string) => Promise<boolean>;
  signal: AbortSignal;
  assertPolicy: () => void;
  report: (message: string) => void;
}): Promise<void> {
  if (!buildFlag("memory_initial_state")) throw Error("Initial memory snapshots unavailable in this build.");
  if (!o.interactive || o.denied(o.snapshot) || !storeExists(o.snapshot))
    return;
  try {
    const text = readPrivateText(o.snapshot, 1048576),
      digest = createHash("sha256").update(text).digest("hex"),
      raw: unknown = JSON.parse(text);
    if (
      !object(raw) ||
      raw.schemaVersion !== 1 ||
      typeof raw.createdAt !== "string" ||
      !Number.isFinite(Date.parse(raw.createdAt)) ||
      Date.parse(raw.createdAt) > Date.now() + 300000 ||
      !object(raw.files) ||
      Object.keys(raw.files).length > 100
    )
      throw new Error();
    const createdAt = Date.parse(raw.createdAt),
      entries = o.memory.entries(),
      expected = new Map(
        entries.map((entry) => [entry.file, o.memory.read(entry.file).text]),
      ),
      replacement = new Map<string, string>();
    for (const [file, content] of Object.entries(raw.files)) {
      if (typeof content !== "string" || o.memory.validate(file, content))
        throw new Error();
      replacement.set(file, content);
    }
    const stateFile = join(o.memory.root, ".snapshot-sync.json");
    let seenAt = 0;
    if (storeExists(stateFile)) {
      const previous: unknown = JSON.parse(readPrivateText(stateFile, 4096));
      if (
        !object(previous) ||
        typeof previous.seenAt !== "number" ||
        !Number.isFinite(previous.seenAt)
      )
        throw new Error();
      seenAt = previous.seenAt;
    }
    if (
      createdAt <= Math.max(seenAt, ...entries.map((entry) => entry.modifiedMs))
    )
      return;
    const accepted = await o.confirm(
      `Instantané de mémoire plus récent (${raw.createdAt}) : ${o.snapshot}\nRemplacer la mémoire locale par ${replacement.size} souvenirs ? Répondre non ignore cette version et conserve les souvenirs actuels. Les souvenirs restent des données externes.`,
    );
    o.signal.throwIfAborted();
    o.assertPolicy();
    if (readPrivateText(o.snapshot, 1048576) !== text) throw new Error();
    if (accepted) o.memory.replaceSnapshot(expected, replacement);
    writeAtomic(
      stateFile,
      Buffer.from(
        JSON.stringify({
          seenAt: createdAt,
          sha256: digest,
          decision: accepted ? "replaced" : "ignored",
        }),
      ),
      currentPlatform(),
      true,
    );
    o.report(
      accepted
        ? "Mémoire locale remplacée par l’instantané approuvé."
        : "Version de l’instantané ignorée ; mémoire locale conservée.",
    );
  } catch {
    if (!o.signal.aborted)
      o.report(
        "Instantané de mémoire illisible, modifié ou concurrent ; mémoire locale conservée.",
      );
  }
}
