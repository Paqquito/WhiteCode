// Implements: SPEC-IHM-025 (CA-01/02, EF-01/02), SPEC-CMD-053 (CA-01), gap E-150.
import { readFileSync } from "node:fs";
import notes from "./notes-version.md" with { type: "text" };
import type { Identity } from "../identity/identity";
import { maskSecrets } from "../shared/secrets";

export function releaseNotes(version: string, cacheFile?: string): string {
  let content = notes;
  if (cacheFile) {
    try {
      const cached: unknown = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (cached && typeof cached === "object" && "text" in cached && typeof cached.text === "string" && cached.text.length <= 100_000) content = cached.text;
    } catch { /* the installed notes remain available offline */ }
  }
  return maskSecrets(`Version installée : ${version}\n${content}`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function welcome(identity: Identity, options: { model: string; cwd: string; credentialSource: string; compact: boolean; news: boolean }): string {
  const title = `${identity.get("PRODUCT")} · ${identity.version}`;
  const lines = options.compact ? [title, `${options.model} · ${options.cwd}`] : [title, `Modèle : ${options.model}`, `Dossier : ${options.cwd}`, `Authentification : ${options.credentialSource}`];
  if (options.news) lines.push(releaseNotes(identity.version));
  return maskSecrets(lines.join("\n"));
}
