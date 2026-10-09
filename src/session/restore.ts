// Implements: SPEC-SES-006 (§ 5.3 step 4, § 5.7 points 1 to 7, FA-01 without dialog, EF-03, EF-06 to EF-09, ERR-02 to ERR-04, RG-03, RG-04, CA-01, CA-04 to CA-12),
//             SPEC-SES-007 (§ 5.3 steps 2 to 6, FA-01, FA-02, EF-04 to EF-06, ERR-01, ERR-03)
// Restoration of the files of a session at a user message: a plan computed without any effect, then applied file by
// file with its preconditions checked again just before each write.

import { createHash } from "node:crypto";
import { rmSync, unlinkSync } from "node:fs";
import { writeAtomic } from "../tools/text-file";
import type { PlatformName } from "../platform/system";
import { observe, sameState, type BlobStore, type FileState, type SnapshotRecord } from "./file-history";
import type { TranscriptRecord } from "./transcript";

export type Operation = "create" | "replace" | "delete";

export interface PlannedFile {
  readonly path: string;
  readonly operation: Operation;
  /** State found when the plan was computed, which must still hold at application (§ 5.7 point 6). */
  readonly current: FileState;
  /** Last state produced or observed by the agent (§ 5.7 point 2). */
  readonly expected: FileState;
  readonly target: FileState;
}

export interface RestorePlan {
  readonly session: string;
  readonly point: string;
  readonly root: string;
  /** Operations without external conflict. */
  readonly operations: readonly PlannedFile[];
  /** Changes made outside the agent since its last known state (FA-01, CA-04 to CA-06). */
  readonly conflicts: readonly PlannedFile[];
  /** Files whose saved content is missing or was never saved (FA-02). */
  readonly unavailable: readonly { readonly path: string; readonly reason: string }[];
  /** Files withdrawn by a known refusal of permission (RG-03, CA-12). */
  readonly removed: readonly { readonly path: string; readonly reason: string }[];
  /** Operations the restoration does not perform (a folder in place of a file). */
  readonly unsupported: readonly { readonly path: string; readonly reason: string }[];
  readonly fingerprint: string;
}

export class RestoreError extends Error {}

const describe = (s: FileState): string =>
  s.kind === "file" ? `fichier ${s.hash.slice(0, 12)}` : s.kind === "absent" ? "absent" : s.kind === "link" ? `lien vers ${s.target}` : s.kind === "directory" ? "dossier" : s.kind === "too_large" ? `fichier non sauvegardé (${s.size} octets)` : "élément spécial";

/**
 * § 5.7: the plan for restoring the files to their state when user message `point` was sent. For each file changed by
 * the agent after that message, the target is its state before the first of those changes. Computing the plan changes
 * nothing (EF-09).
 */
export function computePlan(o: {
  readonly session: string;
  readonly records: readonly TranscriptRecord[];
  readonly point: string;
  readonly root: string;
  readonly blobs: BlobStore;
  readonly maxFileSize: number;
  readonly denied: (path: string) => string | undefined;
  readonly platform: PlatformName;
}): RestorePlan {
  const at = o.records.findIndex((r) => r.id === o.point && r.type === "user" && r.data["synthetic"] !== true && r.data["fromHook"] !== true);
  if (at < 0) throw new RestoreError("Point de reprise introuvable."); // SPEC-SES-007 ERR-01
  const targets = new Map<string, FileState>();
  const known = new Map<string, FileState>();
  o.records.forEach((r, i) => {
    if (r.type !== "file_snapshot") return;
    const s = r.data as unknown as SnapshotRecord;
    if (s.kind === "backup") {
      if (i > at && !targets.has(s.path)) targets.set(s.path, s.before);
      known.set(s.path, s.before);
    } else if (s.kind === "written") known.set(s.path, s.after);
  });
  const operations: PlannedFile[] = [];
  const conflicts: PlannedFile[] = [];
  const unavailable: Array<{ path: string; reason: string }> = [];
  const removed: Array<{ path: string; reason: string }> = [];
  const unsupported: Array<{ path: string; reason: string }> = [];
  for (const [path, target] of [...targets].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const current = observe(path, o.maxFileSize).state;
    if (sameState(current, target)) continue; // already in the target state
    if (target.kind === "too_large") {
      unavailable.push({ path, reason: "contenu non sauvegardé (fichier trop volumineux)" });
      continue;
    }
    if (target.kind === "file" && !o.blobs.get(target.hash)) {
      unavailable.push({ path, reason: "sauvegarde introuvable ou altérée" });
      continue;
    }
    if (target.kind !== "file" && target.kind !== "absent") {
      unsupported.push({ path, reason: `état d'origine non restaurable (${describe(target)})` });
      continue;
    }
    const refusal = o.denied(path);
    if (refusal) {
      removed.push({ path, reason: refusal }); // RG-03: withdrawn, the rest of the plan stays
      continue;
    }
    const expected = known.get(path) ?? target;
    const operation: Operation = target.kind === "absent" ? "delete" : current.kind === "absent" ? "create" : "replace";
    const planned = { path, operation, current, expected, target };
    if (sameState(current, expected)) operations.push(planned);
    else conflicts.push(planned);
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ session: o.session, point: o.point, root: o.root, files: [...operations, ...conflicts].map((f) => [f.path, f.operation, f.current, f.target]) }))
    .digest("hex")
    .slice(0, 16);
  return { session: o.session, point: o.point, root: o.root, operations, conflicts, unavailable, removed, unsupported, fingerprint };
}

export interface RestoreOutcome {
  readonly restored: readonly string[];
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * § 5.3 step 4, § 5.7 points 3 and 7: applies a plan whose consent was checked. Each file is checked again just before
 * its write (EF-07); its present content is saved first (EF-08, ERR-04); a cause proper to a file only stops that file (RG-04).
 */
export function applyPlan(plan: RestorePlan, o: { readonly blobs: BlobStore; readonly maxFileSize: number; readonly record: (s: SnapshotRecord) => void; readonly platform: PlatformName }): RestoreOutcome {
  const restored: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const f of [...plan.operations, ...plan.conflicts]) {
    try {
      const now = observe(f.path, o.maxFileSize);
      if (!sameState(now.state, f.current)) {
        failed.push({ path: f.path, reason: "modifié depuis le calcul du plan" });
        continue;
      }
      // A folder or a special file in place of the file is never removed, even with a consent.
      if (now.state.kind === "directory" || now.state.kind === "other") {
        failed.push({ path: f.path, reason: `un ${describe(now.state)} occupe l'emplacement : non remplacé` });
        continue;
      }
      if (now.state.kind === "too_large") {
        failed.push({ path: f.path, reason: `Impossible de sauvegarder ${f.path} : taille supérieure à la limite, restauration bloquée.` });
        continue;
      }
      if (now.state.kind === "file") {
        try {
          o.blobs.put(now.state.hash, now.bytes!);
        } catch {
          failed.push({ path: f.path, reason: `Impossible de sauvegarder ${f.path} : restauration bloquée.` }); // ERR-04, CA-09
          continue;
        }
      }
      if (now.state.kind !== "absent") o.record({ kind: "backup", path: f.path, before: now.state, reason: "restore" });
      if (f.target.kind === "absent") {
        if (now.state.kind === "link") unlinkSync(f.path);
        else rmSync(f.path, { force: true });
      } else if (f.target.kind === "file") {
        const bytes = o.blobs.get(f.target.hash);
        if (!bytes) {
          failed.push({ path: f.path, reason: "sauvegarde introuvable ou altérée" });
          continue;
        }
        if (now.state.kind === "link") unlinkSync(f.path);
        writeAtomic(f.path, bytes, o.platform);
      }
      const after = observe(f.path, o.maxFileSize).state;
      o.record({ kind: "written", path: f.path, after });
      if (sameState(after, f.target)) restored.push(f.path);
      else failed.push({ path: f.path, reason: "état final différent de l'état visé" });
    } catch (error) {
      failed.push({ path: f.path, reason: (error as Error).message }); // ERR-02, CA-10
    }
  }
  return { restored, failed };
}

const VERB: Readonly<Record<Operation, string>> = { create: "recréer", replace: "rétablir", delete: "supprimer" };

/** SPEC-SES-007 EF-05: planned operations, conflicts, unavailable files and unsupported operations, with the fingerprint. */
export function renderPlan(plan: RestorePlan, outcome?: RestoreOutcome): string {
  const lines = [`Plan de restauration — session ${plan.session}, point ${plan.point}`, `Empreinte du plan : ${plan.fingerprint}`];
  const section = (title: string, items: string[]) => {
    if (items.length > 0) lines.push(`${title} :`, ...items.map((i) => `  ${i}`));
  };
  section("Opérations prévues", plan.operations.map((f) => `${VERB[f.operation]} ${f.path}`));
  section("Conflits externes (modifiés hors de l'agent)", plan.conflicts.map((f) => `${VERB[f.operation]} ${f.path} — attendu : ${describe(f.expected)} ; trouvé : ${describe(f.current)}`));
  section("Fichiers indisponibles", plan.unavailable.map((f) => `${f.path} — ${f.reason}`));
  section("Retirés du plan", plan.removed.map((f) => `${f.path} — ${f.reason}`));
  section("Opérations non prises en charge", plan.unsupported.map((f) => `${f.path} — ${f.reason}`));
  if (plan.operations.length + plan.conflicts.length + plan.unavailable.length + plan.removed.length + plan.unsupported.length === 0) lines.push("Aucun fichier à restaurer.");
  if (outcome) {
    section("Restaurés", [...outcome.restored]);
    if (outcome.failed.length > 0) section(`${outcome.failed.length} fichier(s) n'ont pas pu être restaurés`, outcome.failed.map((f) => `${f.path} — ${f.reason}`));
  }
  lines.push("Les effets des commandes shell ne sont pas suivis : ils ne sont pas restaurés."); // SPEC-SES-006 EF-05
  return `${lines.join("\n")}\n`;
}
