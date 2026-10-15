// Implements: SPEC-MOD-030 (CA-01/02, strict parsing and an unsent draft); E-223.
import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import {
  isWithin,
  realPathOrSelf,
  type PlatformName,
} from "../platform/system";
import { ambiguousPathReason, isNetworkPath } from "../permissions/paths";
import { currentPlatform } from "../platform/system";
export interface DeepLink {
  readonly q: string;
  readonly cwd?: string;
  readonly repo?: string;
}
export function repositoryName(value: string): string | undefined {
  const raw = value.replace(/^https:\/\//, ""),
    m =
      /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(
        raw,
      );
  return m &&
    !m[1]!.includes("..") &&
    ![m[2], m[3]].some((p) => p === "." || p === "..")
    ? `${m[1]!.toLowerCase()}/${m[2]}/${m[3]}`
    : undefined;
}
export function parseDeepLink(value: string, scheme: string): DeepLink {
  if (value.length > 40000 || /[\p{Cc}]/u.test(value))
    throw Error("Lien invalide.");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw Error("Lien invalide.");
  }
  if (
    u.protocol !== scheme + ":" ||
    u.hostname !== "open" ||
    u.port ||
    u.username ||
    u.password ||
    u.hash ||
    !["", "/"].includes(u.pathname)
  )
    throw Error("Lien invalide.");
  for (const key of u.searchParams.keys())
    if (
      !["q", "cwd", "repo"].includes(key) ||
      u.searchParams.getAll(key).length !== 1
    )
      throw Error("Lien invalide.");
  const q = u.searchParams.get("q") ?? "",
    cwd = u.searchParams.get("cwd") ?? undefined,
    raw = u.searchParams.get("repo") ?? undefined,
    repo = raw === undefined ? undefined : repositoryName(raw);
  if (
    q.length > 8192 ||
    [q, cwd, raw].some((v) => v !== undefined && /[\p{Cc}]/u.test(v)) ||
    (cwd !== undefined &&
      (!isAbsolute(cwd) ||
        isNetworkPath(cwd, currentPlatform()) ||
        !!ambiguousPathReason(cwd, currentPlatform()))) ||
    (raw !== undefined && !repo) ||
    (cwd && repo)
  )
    throw Error("Lien invalide.");
  return { q, ...(cwd ? { cwd } : {}), ...(repo ? { repo } : {}) };
}
export function resolveDeepLink(
  link: DeepLink,
  o: {
    home: string;
    repositories: Readonly<Record<string, string>>;
    trusted: readonly string[];
    platform: PlatformName;
  },
): { cwd: string; q: string; unknown: boolean } {
  let cwd = link.cwd,
    unknown = false;
  if (link.repo) {
    const known = o.repositories[link.repo];
    if (known && o.trusted.some((root) => isWithin(known, root, o.platform)))
      cwd = known;
    else unknown = true;
  }
  cwd = resolve(cwd ?? o.home);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory())
    throw Error("Dossier du lien introuvable.");
  return { cwd: realPathOrSelf(cwd), q: link.q, unknown };
}
