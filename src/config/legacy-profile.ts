// Implements: SPEC-CAD-002/CA-16 (explicit previous-profile copy without deleting the source), gap E-191.
import * as fs from "node:fs";
import { resolve, join, relative, isAbsolute, sep, dirname } from "node:path";
import { restrictFileToOwner } from "../platform/private-file";
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
  );
};
const stamp = (s: fs.Stats) =>
  `${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export async function migrateLegacyProfile(o: {
  sources: readonly string[];
  destination: string;
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
}): Promise<boolean> {
  const destination = resolve(o.destination);
  if (!o.interactive || fs.existsSync(destination)) return false;
  const source = o.sources
    .map((value) => resolve(value))
    .find((path) => fs.existsSync(path));
  if (!source) return false;
  if (
    source === dirname(source) ||
    inside(source, destination) ||
    inside(destination, source) ||
    fs.realpathSync(source) !== source ||
    fs.lstatSync(source).isSymbolicLink() ||
    !fs.lstatSync(source).isDirectory()
  )
    throw Error("Ancien profil lié, trop large ou superposé au nouveau.");
  if (fs.existsSync(join(source, "archives-v1")))
    throw Error(
      "Ancien profil chiffré : migration de clé entre identités non prise en charge ; aucune copie effectuée.",
    );
  if (
    !(await o.confirm(
      `Ancien profil déclaré : ${source}\nCopier sa configuration et ses données dans ${destination} ? L’ancien dossier sera conservé. Les identifiants du coffre système ne sont pas transférés automatiquement.`,
    ))
  )
    return false;
  if (fs.existsSync(destination))
    throw Error(
      "Nouveau profil créé pendant le dialogue ; aucune donnée écrasée.",
    );
  const files: Array<{
    relative: string;
    source: string;
    bytes: Buffer;
    stat: fs.Stats;
  }> = [];
  let total = 0,
    count = 0;
  const walk = (folder: string, depth: number) => {
    if (depth > 12) throw Error("Ancien profil trop profond.");
    for (const name of fs.readdirSync(folder)) {
      if (++count > 5000) throw Error("Ancien profil trop volumineux.");
      if (/\.(lock|active)$/.test(name)) continue;
      const path = join(folder, name),
        stat = fs.lstatSync(path);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
        throw Error("Lien dans l’ancien profil ; copie refusée.");
      if (stat.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (
        !stat.isFile() ||
        stat.size > 16 * 1024 * 1024 ||
        (total += stat.size) > 64 * 1024 * 1024
      )
        throw Error("Ancien profil non ordinaire ou trop volumineux.");
      const fd = fs.openSync(
        path,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = fs.fstatSync(fd);
        if (stamp(opened) !== stamp(stat))
          throw Error("Ancien profil modifié.");
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
          if (!n) break;
          length += n;
        }
        if (
          length !== stat.size ||
          stamp(fs.fstatSync(fd)) !== stamp(stat) ||
          stamp(fs.lstatSync(path)) !== stamp(stat)
        )
          throw Error("Ancien profil modifié pendant sa lecture.");
        files.push({
          relative: relative(source, path),
          source: path,
          bytes: bytes.subarray(0, length),
          stat,
        });
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  walk(source, 0);
  const parent = dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (
    fs.realpathSync(parent) !== parent ||
    fs.lstatSync(parent).isSymbolicLink()
  )
    throw Error("Parent du nouveau profil lié.");
  const staging = fs.mkdtempSync(join(parent, ".profile-copy-")),
    initial = fs.lstatSync(staging);
  try {
    for (const entry of files) {
      const path = join(staging, entry.relative);
      if (!inside(staging, path)) throw Error("Chemin hors migration.");
      fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path, entry.bytes, {
        flag: "wx",
        mode: (entry.stat.mode & 0o700) | 0o600,
      });
      restrictFileToOwner(path);
    }
    for (const entry of files)
      if (stamp(fs.lstatSync(entry.source)) !== stamp(entry.stat))
        throw Error(
          "Ancien profil modifié avant validation ; copie abandonnée.",
        );
    if (fs.existsSync(destination))
      throw Error("Nouveau profil créé ; copie abandonnée.");
    fs.renameSync(staging, destination);
    return true;
  } catch (error) {
    try {
      const now = fs.lstatSync(staging);
      if (
        !now.isSymbolicLink() &&
        now.ino === initial.ino &&
        now.dev === initial.dev &&
        fs.realpathSync(staging) === staging
      )
        fs.rmSync(staging, { recursive: true });
    } catch {}
    throw error;
  }
}
