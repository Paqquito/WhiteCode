// Implements: SPEC-CFG-009 (CA-01/02/03, EF-01/02/03/04/05, RG-01/02), gap E-153.
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tryFileLock } from "../platform/file-lock";
import { writeAtomic } from "../tools/text-file";
import type { PlatformName } from "../platform/system";
import { readUserState, updateUserState } from "./user-state";
import { convertDeprecated, WELCOME_MIGRATION } from "./deprecated";
import { Settings } from "./settings";
export async function migrateConfiguration(options: { userFile: string; localFile?: string; stateFile: string; platform: PlatformName; retentionDays: number; warn: (text: string) => void; fault?: () => void }): Promise<boolean> {
  const files = [options.userFile, ...(options.localFile ? [options.localFile] : [])];
  const hasOld = files.some(path => { try { return readFileSync(path, "utf8").includes("compactWelcome"); } catch { return false; } });
  if (!hasOld || readUserState(options.stateFile).migrations?.includes(WELCOME_MIGRATION)) return false;
  let release: (() => void) | undefined; const backups: Array<{ path: string; before: Uint8Array; after: string }> = [];
  try {
    const profile = dirname(options.stateFile), directory = join(profile, "migration-backups");
    mkdirSync(profile, { recursive: true, mode: 0o700 }); release = tryFileLock(join(profile, "migrations.lock"));
    if (!release) { options.warn("Migration de configuration différée : un autre démarrage la pilote."); return false; }
    if (readUserState(options.stateFile).migrations?.includes(WELCOME_MIGRATION)) return false;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); if (lstatSync(directory).isSymbolicLink()) throw new Error();
    for (const path of files) {
      let stat; try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 3_000_000) throw new Error();
      const before = readFileSync(path), result = convertDeprecated(before.toString("utf8")); if (!result.changed) continue;
      const validation = Settings.load({ sources: [{ scope: path === options.userFile ? "user" : "local", name: path, text: result.text }], projectTrusted: true });
      if (validation.issues.some(issue => ["type", "range", "invalid-json", "restrictive"].includes(issue.kind ?? ""))) throw new Error();
      const backup = join(directory, `${Date.now()}-${randomUUID()}.bak`); writeAtomic(backup, before, options.platform, true);
      backups.push({ path, before, after: result.text });
      writeAtomic(path, Buffer.from(result.text), options.platform, true); options.fault?.();
    }
    if (!backups.length) return false;
    await updateUserState(options.stateFile, state => ({ ...state, migrations: [...new Set([...(state.migrations ?? []), WELCOME_MIGRATION])] }), options.platform);
    options.warn("Migration appliquée : ui.compactWelcome devient ui.welcome.compact ; sauvegarde conservée.");
    const cutoff = Date.now() - options.retentionDays * 86400_000;
    for (const name of readdirSync(directory)) if (/^\d+-[a-f0-9-]+\.bak$/.test(name)) { const file = join(directory, name); try { const stat = lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) unlinkSync(file); } catch { /* retry later */ } }
    return true;
  } catch {
    for (const backup of [...backups].reverse()) try {
      // Do not overwrite an external edit made while the state journal was being written.
      if (readFileSync(backup.path, "utf8") === backup.after) writeAtomic(backup.path, backup.before, options.platform, true);
      else options.warn("Configuration modifiée simultanément ; restaurez la sauvegarde manuellement.");
    } catch { options.warn("Restauration de configuration impossible ; sauvegarde conservée."); }
    options.warn("Mise à jour de votre configuration impossible ; réessai au prochain démarrage."); return false;
  } finally { release?.(); }
}
