// Implements: SPEC-MOT-043 (atomic bounded informational output), gap E-170.
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeAtomic } from "../tools/text-file";
import type { PlatformName } from "../platform/system";
export function writeJobState(folder: string, value: { state: string; summary: string }, platform: PlatformName): void {
  const root = resolve(folder); let ancestor = root;
  for (;;) { const stat = lstatSync(ancestor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Job workspace must be an ordinary directory."); const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
  const path = join(root, "job-state.json");
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Job state must be an ordinary file."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  writeAtomic(path, Buffer.from(JSON.stringify(value) + "\n"), platform, true);
}
