// Implements: SPEC-CAD-002 (CA-08, CA-09, CA-19: standalone scan and Markdown rendering).
// Supports: SPEC-CAD-002 (EF-31 to EF-34: text/binary scanning, gzip inspection; other archives explicitly refused).
// Supports: gap E-133 (exact relative file/line exceptions; distinct empty output; no symlink traversal).
// Supports: SPEC-BLD-003 (unchanged scan inputs reused by content fingerprints), gap E-148.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Identity } from "./identity";
import { MODEL_TIERS, type ModelTier } from "./runtime-catalog";
import { parseTemplate, renderDocument, renderTemplate } from "./template";

function files(root: string): string[] {
  if (!lstatSync(root).isDirectory()) throw new Error("Dossier source attendu.");
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Lien non parcouru : ${file}.`);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) out.push(file);
      else throw new Error(`Élément spécial non parcouru : ${file}.`);
    }
  };
  visit(root);
  return out;
}

const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[_\-\s]/gu, "");
export interface ScanIssue { readonly file: string; readonly line: number; readonly column: number; readonly term: string }
/** Invocation-owned cache: no file content or private list is persisted. */
export type ScanCache = Map<string, { readonly fingerprint: string; readonly issues: readonly ScanIssue[] }>;

/** No extraction to disk. Unknown compression and excessive nested/expanded content fail the control. */
function scanBytes(file: string): Buffer {
  let bytes = readFileSync(file);
  let depth = 0;
  let compressed = /\.(gz|tgz)$/i.test(file);
  while (compressed || (bytes[0] === 31 && bytes[1] === 139)) {
    if (++depth > 4) throw new Error(`Compression trop imbriquée : ${file}.`);
    bytes = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
    compressed = false;
  }
  const signatures = ["504b0304", "504b0506", "504b0708", "425a68", "fd377a585a00", "28b52ffd", "377abcaf271c", "526172211a07"];
  if (/\.(zip|bz2|xz|zst|zstd|7z|rar|br|tar|tgz|tar\.gz)$/i.test(file) || signatures.some((magic) => bytes.subarray(0, magic.length / 2).toString("hex") === magic) || bytes.subarray(257, 262).toString() === "ustar") throw new Error(`Format compressé non pris en charge : ${file}.`);
  return bytes;
}

/** Binary strings may use either UTF-16 byte order and either alignment. Scan one decoding at a time. */
function* scanTexts(bytes: Buffer): Generator<{ text: string; bytePrefix?: number }> {
  const text = bytes.toString("utf8");
  yield { text };
  for (const prefix of [0, 1]) {
    const end = prefix + Math.floor((bytes.length - prefix) / 2) * 2;
    const units = bytes.subarray(prefix, end);
    yield { text: units.toString("utf16le"), bytePrefix: prefix };
    yield { text: Buffer.from(units).swap16().toString("utf16le"), bytePrefix: prefix };
  }
}

/** Text positions use original UTF-16 units; binary UTF-16 positions use a one-based byte offset. */
export function scanDirectory(root: string, identity: Identity, cache?: ScanCache): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const seen = new Set<string>();
  const terms = identity.resolved.compatibility.forbiddenTerms.map((term) => ({ term, key: normalize(term) })).filter((t) => t.key !== "");
  const rulesHash = cache ? createHash("sha256").update(JSON.stringify(identity.resolved.compatibility)).digest("hex") : "";
  for (const file of files(root)) {
    const bytes = scanBytes(file);
    if (terms.length === 0) continue; // Still validate file kinds and compression before skipping text normalization.
    const path = relative(root, file).replace(/\\/g, "/");
    const fingerprint = cache ? `${createHash("sha256").update(bytes).digest("hex")}:${rulesHash}` : "";
    const previous = cache?.get(path);
    if (previous?.fingerprint === fingerprint) { issues.push(...previous.issues.map(issue => ({ ...issue }))); continue; }
    const firstIssue = issues.length;
    for (const { text, bytePrefix } of scanTexts(bytes)) {
      const normalized = normalize(text);
      const hits: Array<{ index: number; term: string }> = [];
      for (const { term, key } of terms) {
        let index = normalized.indexOf(key);
        while (index >= 0) { hits.push({ index, term }); index = normalized.indexOf(key, index + 1); }
      }
      hits.sort((a, b) => a.index - b.index || a.term.localeCompare(b.term));
      let offset = 0, count = 0, line = 1, column = 1;
      for (const hit of hits) {
        while (offset < text.length) {
          const char = String.fromCodePoint(text.codePointAt(offset)!);
          const length = normalize(char).length;
          if (count + length > hit.index) break;
          count += length;
          offset += char.length;
          if (char === "\n") { line++; column = 1; } else column += char.length;
        }
        const issueLine = bytePrefix === undefined ? line : 1;
        const issueColumn = bytePrefix === undefined ? column : bytePrefix + offset * 2 + 1;
        const excepted = identity.resolved.compatibility.scanExceptions?.some((e) => normalize(e.terme) === normalize(hit.term) && (e.contexte === path || (bytePrefix === undefined && e.contexte === `${path}:${issueLine}`)));
        const key = JSON.stringify([path, issueLine, issueColumn, hit.term]);
        if (!excepted && !seen.has(key)) { seen.add(key); issues.push({ file: path, line: issueLine, column: issueColumn, term: hit.term }); }
      }
    }
    if (cache) {
      if (cache.size >= 128 && !cache.has(path)) cache.clear();
      cache.set(path, { fingerprint, issues: issues.slice(firstIssue).map(issue => ({ ...issue })) });
    }
  }
  return issues;
}

function physical(path: string): string {
  let existing = resolve(path);
  while (!existsSync(existing)) { const parent = dirname(existing); if (parent === existing) throw new Error("Dossier de sortie inaccessible."); existing = parent; }
  return resolve(realpathSync(existing), relative(existing, resolve(path)));
}
const within = (root: string, file: string) => { const rel = relative(root, file); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };

/** The complete render is validated before output is written; assets are copied, Markdown documents are rendered. */
export function renderDirectory(source: string, output: string, identity: Identity, language: string): number {
  const inputRoot = realpathSync(source), outputRoot = physical(output);
  if (within(inputRoot, outputRoot) || within(outputRoot, inputRoot)) throw new Error("Sortie et source doivent être des dossiers distincts, sans inclusion.");
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory() || readdirSync(output).length > 0)) throw new Error("La sortie doit être vide ou inexistante, sans lien.");
  const options = { lookup: (name: string) => (MODEL_TIERS as readonly string[]).includes(name) ? identity.tierLabel(name as ModelTier, language) : identity.has(name) ? identity.get(name, language) : undefined, onUnknownVariable: (name: string) => { throw new Error(`[ERR-06] Variable inconnue : ${name}.`); }, onUnknownTransform: (name: string) => { throw new Error(`[ERR-07] Transformation inconnue : ${name}.`); } };
  const rendered = files(source).map((file) => {
    const name = renderTemplate(relative(source, file), options);
    const target = resolve(outputRoot, name);
    if (!within(outputRoot, target) || target === outputRoot) throw new Error("Chemin rendu hors du dossier de sortie.");
    if (relative(outputRoot, target).split(sep).some((part) => part.length > 255 || Buffer.byteLength(part) > 255 || /[<>:"|?*\\\u0000-\u001F]|[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error("Nom de fichier rendu non portable.");
    const bytes = readFileSync(file);
    const data = file.toLowerCase().endsWith(".md") ? Buffer.from(renderDocument(bytes.toString("utf8"), options)) : bytes;
    if (!file.toLowerCase().endsWith(".md") && parseTemplate(data.toString("utf8")).some((p) => p.kind === "variable")) throw new Error(`[ERR-06] Gabarit non Markdown non pris en charge : ${file}.`);
    return { target, data };
  });
  const pathKey = (path: string) => path.normalize("NFC").toLowerCase();
  const targets = new Set(rendered.map((f) => pathKey(f.target)));
  if (targets.size !== rendered.length) throw new Error("Plusieurs sources produisent le même fichier.");
  for (const file of rendered) {
    let parent = dirname(file.target);
    while (pathKey(parent) !== pathKey(outputRoot)) {
      if (targets.has(pathKey(parent))) throw new Error("Un chemin rendu est à la fois fichier et dossier.");
      const next = dirname(parent);
      if (next === parent) throw new Error("Chemin rendu hors du dossier de sortie.");
      parent = next;
    }
  }
  mkdirSync(outputRoot, { recursive: true });
  for (const file of rendered) { mkdirSync(dirname(file.target), { recursive: true }); writeFileSync(file.target, file.data, { flag: "wx" }); }
  return rendered.length;
}
