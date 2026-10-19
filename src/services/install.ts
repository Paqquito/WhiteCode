// Implements: SPEC-CMD-080 (explicit directory choice outside projects and durable installation).
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ordinaryPrivateFile } from "../shared/private-text";
import {
  realPathOrSelf,
  isWithin,
  type PlatformName,
} from "../platform/system";
import { setValueInSettingsFile } from "../config/settings-writer";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };

export function defaultAssistantDirectory(home: string, slug: string): string {
  if (!buildFlag("mode_assistant_persistent")) throw Error("Assistant persistant absent de cette distribution.");
  return join(home, slug + "-assistant");
}
export function installAssistant(options: {
  directory: string;
  project: string;
  projectDirectory: string;
  settingsFile: string;
  platform: PlatformName;
}): string {
  if (!buildFlag("mode_assistant_persistent")) throw Error("Assistant persistant absent de cette distribution.");
  if (
    !isAbsolute(options.directory) ||
    options.directory.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(options.directory)
  )
    throw Error("Le dossier d’installation doit être un chemin absolu.");
  const directory = realPathOrSelf(resolve(options.directory));
  if (isWithin(directory, realPathOrSelf(options.project), options.platform))
    throw Error("Le dossier de l’assistant doit être hors du projet courant.");
  for (let ancestor = directory; ;) {
    if (existsSync(join(ancestor, ".git")))
      throw Error("Le dossier d’installation appartient à un dépôt Git.");
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  ordinaryPrivateFile(join(directory, ".install-check"), 0);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  setValueInSettingsFile(
    options.settingsFile,
    ["assistant", "installDirectory"],
    directory,
    options.platform,
  );
  return directory;
}
