// Implements: SPEC-CFG-010 (CA-01, CA-02, CA-03, EF-03, EF-04, FA-01, § 12: concurrent state and recovery).
// Supports: gap E-134 (bounded exclusive lock, union of trust changes; explicit failure on sustained contention).
// Supports: SPEC-PER-018 (consent version, date and revocation), gap E-138.
// Supports: SPEC-IHM-025 (CA-02, once-per-version state), gap E-150.
import { lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomic } from "../tools/text-file";
import { restrictFileToOwner } from "../platform/private-file";
import { tryFileLock } from "../platform/file-lock";
import { currentPlatform, type PlatformName } from "../platform/system";

export interface UserState {
  readonly migrations?: readonly string[];
  readonly lastSeenVersion?: string;
  readonly trustedProjects?: readonly string[];
  readonly restrictedProjects?: readonly string[];
  readonly unrestrictedAccepted?: boolean;
  readonly autoApproveConsent?: { readonly version: number; readonly at: string };
  readonly modelNotices?: Readonly<Record<string, string>>;
  readonly keyConfirmations?: Readonly<Record<string, boolean>>;
  readonly projects?: Readonly<Record<string, unknown>>;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
class CorruptState extends Error {}
function load(path: string): UserState {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("L'état utilisateur doit être un fichier ordinaire sans lien.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (error instanceof SyntaxError) throw new CorruptState(); throw error; }
  if (!object(value) || ["trustedProjects", "restrictedProjects", "migrations"].some((key) => value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((p) => typeof p !== "string"))) ||
      (value["lastSeenVersion"] !== undefined && (typeof value["lastSeenVersion"] !== "string" || value["lastSeenVersion"].length > 100)) ||
      (value["unrestrictedAccepted"] !== undefined && typeof value["unrestrictedAccepted"] !== "boolean") ||
      (value["autoApproveConsent"] !== undefined && (!object(value["autoApproveConsent"]) || !Number.isSafeInteger(value["autoApproveConsent"]["version"]) ||
        typeof value["autoApproveConsent"]["at"] !== "string" || !Number.isFinite(Date.parse(value["autoApproveConsent"]["at"])))) ||
      (value["modelNotices"] !== undefined && (!object(value["modelNotices"]) || Object.values(value["modelNotices"]).some((p) => typeof p !== "string"))) ||
      (value["keyConfirmations"] !== undefined && (!object(value["keyConfirmations"]) || Object.entries(value["keyConfirmations"]).some(([key, answer]) => !/^[a-f0-9]{64}$/.test(key) || typeof answer !== "boolean"))) ||
      (value["projects"] !== undefined && (!object(value["projects"]) || Object.values(value["projects"]).some((p) => !object(p))))) throw new CorruptState();
  return value as UserState;
}

/** Read-only load; startup and every writer perform recovery under the same exclusive lock. */
export function readUserState(path: string): UserState {
  try { return load(path); } catch (error) { if (error instanceof CorruptState) return {}; throw error; }
}

async function locked<T>(path: string, action: () => T): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const lock = path + ".lock";
  const deadline = Date.now() + 30_000;
  let release: (() => void) | undefined, delay = 10;
  while (!(release = tryFileLock(lock))) {
      if (Date.now() >= deadline) throw new Error("État utilisateur verrouillé : modification non enregistrée, réessayez après la fermeture de l'autre session.");
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(250, delay * 2);
  }
  try { return action(); } finally { release(); }
}

function loadOrRecover(path: string, warn: (message: string) => void): UserState {
  try { return load(path); }
  catch (error) {
    if (!(error instanceof CorruptState)) throw error;
    const backup = path + ".corrupt-" + randomUUID();
    renameSync(path, backup);
    restrictFileToOwner(backup);
    writeAtomic(path, Buffer.from("{}\n"), currentPlatform(), true);
    warn(`Votre état local était illisible et a été réinitialisé (copie conservée : ${backup}).`);
    return {};
  }
}

export async function recoverUserState(path: string, warn: (message: string) => void): Promise<void> {
  try { load(path); }
  catch (error) {
    if (!(error instanceof CorruptState)) throw error;
    await locked(path, () => { loadOrRecover(path, warn); });
  }
}

function merge(state: UserState, patch: Partial<UserState>): UserState {
  const next = { ...state, ...patch };
  for (const key of ["trustedProjects", "restrictedProjects"] as const) if (patch[key]) next[key] = [...new Set([...(state[key] ?? []), ...patch[key]])];
  if (patch.modelNotices) next.modelNotices = { ...state.modelNotices, ...patch.modelNotices };
  if (patch.keyConfirmations) next.keyConfirmations = { ...state.keyConfirmations, ...patch.keyConfirmations };
  if (patch.projects) next.projects = mergeObjects(state.projects ?? {}, patch.projects);
  return next;
}

function mergeObjects(base: Readonly<Record<string, unknown>>, patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map((key) => {
    const value = Object.hasOwn(patch, key) ? patch[key] : base[key];
    return [key, object(value) && object(base[key]) ? mergeObjects(base[key], value) : value];
  }));
}

/** Transformations implement removals; patches merge into the version reread after acquiring the lock. */
export async function updateUserState(path: string, change: Partial<UserState> | ((state: UserState) => UserState), platform: PlatformName, warn: (message: string) => void = () => {}): Promise<void> {
  await locked(path, () => {
    const state = loadOrRecover(path, warn);
    const next = typeof change === "function" ? change(state) : merge(state, change);
    writeAtomic(path, Buffer.from(JSON.stringify(next, null, 2) + "\n"), platform, true);
  });
  // Let another process acquire the released lock before a tight writer loop reacquires it.
  await new Promise((resolve) => setTimeout(resolve, 10));
}
