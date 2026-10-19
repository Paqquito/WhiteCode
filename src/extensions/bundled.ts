// Implements: SPEC-EXT-013 (offline bundled resources loaded through the normal extension pipeline).
import { join } from "node:path";
import { storeMkdir } from "../session/private-storage";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";
import reviewKit from "../../prompts/bundled/review-kit.md" with { type: "text" };

export const BUNDLED_EXTENSIONS = [
  {
    name: "review-kit",
    version: "1.0.0",
    description:
      "Liste de vérification de revue ; extension intégrée, désactivée par défaut.",
  },
] as const;
export function ensureBundled(configDir: string): void {
  for (const extension of BUNDLED_EXTENSIONS) {
    const root = join(
        configDir,
        "extensions",
        "bundled",
        extension.name,
        extension.version,
      ),
      files: { [path: string]: string } = {
        "extension.json": JSON.stringify({
          ...extension,
          description: "Prepare an evidence-based review checklist.",
        }),
        "skills/checklist/definition.md": reviewKit,
      };
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, file);
      ordinaryPrivateFile(path, 65536);
      let existing: string | undefined;
      try {
        existing = readPrivateText(path, 65536);
      } catch {}
      if (existing !== content) {
        storeMkdir(join(path, ".."), { recursive: true, mode: 0o700 });
        try { writeAtomic(path, Buffer.from(content), currentPlatform(), true); }
        catch (error) {
          // A concurrent startup may publish these immutable bytes while Windows keeps the destination open.
          try { if (readPrivateText(path, 65536) === content) continue; } catch {}
          throw error;
        }
      }
    }
  }
}
// Supports: gap E-255 (only an identical guarded publication can satisfy a concurrent startup).
