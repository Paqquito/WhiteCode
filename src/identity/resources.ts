// Implements: SPEC-CAD-002 (EF-04: binary resources referenced by a path relative to the identity file; ERR-10; § 6.3.8 ICON).
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { IdentityIssue, ResolvedIdentity } from "./resolver";

/** § 6.3.8 default for `ICON`: a neutral generic icon, a plain black square. */
export const DEFAULT_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#000000"/></svg>\n';

/** Bounded resource size: large resources are referenced by path, never embedded, yet a build must stay reasonable. */
export const MAX_ICON_BYTES = 8 * 1024 * 1024;
export const MIN_ICON_PIXELS = 512;

export interface IconResource {
  readonly format: "svg" | "png";
  readonly data: Buffer;
  /** Absolute source path, or null for the neutral default. */
  readonly source: string | null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function isSvg(data: Buffer): boolean {
  const text = data.toString("utf8").replace(/^﻿/, "");
  // The root element must be <svg>, possibly after an XML declaration, comments or a doctype.
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(text) && /<\/svg>\s*$/i.test(text);
}

/**
 * Loads the brand icon of a resolved identity. `identityFile` locates the relative path (EF-04); a missing,
 * unreadable, escaping or malformed resource is ERR-10. Without `ICON`, the neutral default is returned.
 */
export function loadIcon(identity: ResolvedIdentity, identityFile: string): { icon?: IconResource; issues: IdentityIssue[] } {
  const value = identity.values["ICON"]?.value;
  if (value === undefined) return { icon: { format: "svg", data: Buffer.from(DEFAULT_ICON_SVG, "utf8"), source: null }, issues: [] };
  const refused = (detail: string): { issues: IdentityIssue[] } => ({
    issues: [{ code: "ERR-10", severity: "error", message: `Ressource \`ICON\` introuvable ou format non pris en charge : ${detail}`, path: "ICON" }],
  });
  if (typeof value !== "string") return refused("chemin attendu.");
  const base = dirname(resolve(identityFile));
  const file = resolve(base, value);
  let real: string;
  try {
    if (!lstatSync(file).isFile()) return refused(`${value} n'est pas un fichier.`);
    real = realpathSync(file);
    const realBase = realpathSync(base), inside = relative(realBase, real);
    if (inside.startsWith("..") || isAbsolute(inside)) return refused(`${value} sort du dossier du fichier d'identité.`);
  } catch {
    return refused(`${value} est introuvable.`);
  }
  const data = readFileSync(real);
  if (data.length === 0 || data.length > MAX_ICON_BYTES) return refused(`${value} doit peser entre 1 octet et ${MAX_ICON_BYTES / 1024 / 1024} Mio.`);
  if (/\.png$/i.test(value)) {
    const size = pngSize(data);
    if (!size) return refused(`${value} n'est pas un PNG valide.`);
    if (size.width < MIN_ICON_PIXELS || size.height < MIN_ICON_PIXELS) return refused(`${value} mesure ${size.width}×${size.height} px (au moins ${MIN_ICON_PIXELS} px attendus).`);
    return { icon: { format: "png", data, source: real }, issues: [] };
  }
  if (!isSvg(data)) return refused(`${value} n'est pas un SVG valide.`);
  return { icon: { format: "svg", data, source: real }, issues: [] };
}
