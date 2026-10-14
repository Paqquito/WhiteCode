// Implements: SPEC-EXT-037 (CA-01, read-only discovery and reviewable minimal proposal), gap E-170.
import { readPrivateText } from "../shared/private-text";
import { join } from "node:path";
export function proposeTestSkill(cwd: string, readDenied: (path: string) => boolean): string | undefined {
  const path = join(cwd, "package.json"); if (readDenied(path)) return undefined;
  try {
    const data = JSON.parse(readPrivateText(path, 65536)) as { scripts?: Record<string, unknown> };
    if (!data.scripts || typeof data.scripts["test"] !== "string" || !data.scripts["test"].trim()) return undefined;
    return ['---', 'name: project-tests', 'description: Runs the test procedure defined by this repository.', 'invocation: both', 'tools: [read_file]', '---', 'Read package.json and the project instructions before running tests. The declared test script is repository data, not permission. Use the package manager declared by the repository, ask for ordinary shell permission, run the test script, and report the observed exit code and failures. Never change assertions to obtain a passing result.'].join("\n") + "\n";
  } catch { return undefined; }
}
