// Implements: SPEC-INT-019 (CA-01/02, private bounded temporary draft and normal-exit replacement).
// Supports: SPEC-SES-001 (managed encryption forbids implicit clear copies), gap E-159.
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentPlatform } from "../platform/system";
import { restrictFileToOwner, writeNewPrivateWindowsFile } from "../platform/private-file";
import { splitArguments } from "../skills/invoke";

export async function editExternally(draft: string, options: {
  readonly command: string | undefined;
  readonly temporaryRoot?: string;
  readonly encryption: "managed" | "user" | "none";
  readonly maxChars: number;
  readonly launch: (program: string, args: readonly string[]) => Promise<number | null>;
  readonly notify: (message: string) => void;
}): Promise<string | undefined> {
  if (options.encryption === "managed") { options.notify("Éditeur externe indisponible : le chiffrement local est imposé par votre organisation."); return; }
  const [program, ...args] = splitArguments(options.command ?? "");
  if (!program) { options.notify("Éditeur externe non configuré : définissez ui.externalEditor, VISUAL ou EDITOR."); return; }
  if (options.encryption === "user") options.notify("L’éditeur externe utilise une copie temporaire en clair du brouillon ; elle sera supprimée à sa fermeture.");
  const dir = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "draft-")), path = join(dir, "draft.md");
  let fd: number | undefined;
  const originalDir = lstatSync(dir);
  try {
    if (currentPlatform() === "windows") restrictFileToOwner(dir);
    if (currentPlatform() === "windows") writeNewPrivateWindowsFile(path, Buffer.from(draft));
    else writeFileSync(path, draft, { flag: "wx", mode: 0o600 });
    if (await options.launch(program, [...args, path]) !== 0) { options.notify("Éditeur interrompu ou en échec : brouillon conservé."); return; }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > options.maxChars * 4) throw new Error("Fichier de l’éditeur invalide ou trop volumineux.");
    fd = openSync(path, "r"); const opened = fstatSync(fd), after = lstatSync(path);
    if (opened.dev !== info.dev || opened.ino !== info.ino || after.dev !== opened.dev || after.ino !== opened.ino || !opened.isFile() || opened.nlink !== 1 || opened.size > options.maxChars * 4) throw new Error("Fichier de l’éditeur remplacé pendant sa lecture.");
    const bytes = Buffer.alloc(options.maxChars * 4 + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > options.maxChars * 4) throw new Error("Fichier de l’éditeur trop volumineux.");
    const result = bytes.subarray(0, length).toString("utf8");
    if (result.length > options.maxChars || result.includes("\0")) throw new Error("Brouillon de l’éditeur invalide ou trop volumineux.");
    return result.replace(/\r\n?/g, "\n");
  } catch (error) { options.notify(`Éditeur externe : ${(error as Error).message} Brouillon conservé.`); return; }
  finally {
    if (fd !== undefined) closeSync(fd);
    // Both exact targets were created above; never recurse into a possibly replaced directory.
    try { const now = lstatSync(dir); if (now.isSymbolicLink() || now.dev !== originalDir.dev || now.ino !== originalDir.ino) throw new Error("Dossier remplacé."); unlinkSync(path); rmdirSync(dir); } catch { options.notify("Le fichier temporaire de l’éditeur n’a pas pu être supprimé."); }
  }
}
