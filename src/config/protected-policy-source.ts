// Supports: SPEC-CFG-003 (FA-02, protected independent policy sources), gaps E-124, E-126.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { PolicyAnchor } from "../identity/resolver";
import type { ConfigIssue } from "./settings";
import { inspectPolicyFileProtection, type PolicyFileProtection, type PolicyFileProtectionReader } from "../platform/policy-file";

/** Policy bytes receive authority from an independent anchor; metadata authority requires separate protection checks. */
export function readPolicySource(file: string, anchor?: PolicyAnchor, protection: PolicyFileProtectionReader = inspectPolicyFileProtection): { text?: string; issue?: ConfigIssue; protection?: PolicyFileProtection } {
  const rejected = (reason: string): ConfigIssue => ({ code: "ERR-03", severity: "error", kind: "policy", scope: "managed",
    message: `${anchor ? `Politique obligatoire de l'organisation ${anchor.organizationId}` : `Source de politique gérée ${file}`} : ${reason}. ${anchor?.perimeter === "remote" ? "Périmètre distant ; sessions distantes bloquées." : "Périmètre inconnu ; fonctions d'agent bloquées."}` });
  let fd: number | undefined;
  let detected = false;
  try {
    const first = lstatSync(file);
    detected = true;
    if (!first.isFile() || first.isSymbolicLink()) return { issue: rejected("fichier ordinaire sans lien symbolique attendu") };
    const before = protection(file);
    if (before.error !== undefined || typeof before.writable !== "boolean") return { issue: rejected(`protection invérifiable (${before.error ?? "unavailable"})`) };
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    const stamp = (stat: typeof first) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (!opened.isFile() || opened.size > 1024 * 1024 || stamp(first) !== stamp(opened)) return { issue: rejected("source non ordinaire, trop volumineuse ou remplacée pendant la lecture") };
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 1024 * 1024) return { issue: rejected("source trop volumineuse") };
    const bytes = buffer.subarray(0, length);
    const after = protection(file);
    if (after.error !== undefined || typeof after.writable !== "boolean" || stamp(opened) !== stamp(fstatSync(fd)) || stamp(opened) !== stamp(lstatSync(file))) return { issue: rejected("source ou protection modifiée pendant la lecture") };
    if (anchor && createHash("sha256").update(bytes).digest("hex") !== anchor.policySha256) return { issue: rejected("empreinte non autorisée par l'ancrage") };
    return { text: bytes.toString("utf8"), protection: { writable: before.writable || after.writable } };
  } catch (error) {
    if (!anchor && !detected && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { issue: rejected("source absente ou illisible") };
  } finally { if (fd !== undefined) closeSync(fd); }
}
