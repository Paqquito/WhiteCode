// Implements: SPEC-CMD-033 (§ 5.1 the eight phases, § 5.3, FA-01, FA-02, EF-01 to EF-03, RG-01, CA-01, CA-02)
// Supports: gap E-116
// The request sent to the model by /create-instructions: the first version, or the guided one whose phases are only
// those the user chose in phase 1.

import firstVersion from "../../prompts/commands/create-instructions.md" with { type: "text" };
import guidedVersion from "../../prompts/commands/create-instructions-guided.md" with { type: "text" };

export type SetupChoice = "project" | "personal" | "skills" | "hooks";

export const SETUP_CHOICES: ReadonlyArray<{ readonly id: SetupChoice; readonly label: string; readonly words: readonly string[] }> = [
  { id: "project", label: "instructions du projet", words: ["projet", "project"] },
  { id: "personal", label: "instructions personnelles", words: ["personnel", "personal"] },
  { id: "skills", label: "compétences", words: ["compétences", "competences", "skills"] },
  { id: "hooks", label: "crochets", words: ["crochets", "hooks"] },
];

/** The choices named in the arguments (`compétences crochets`), or undefined when an argument is unknown. */
export function parseChoices(args: string): SetupChoice[] | undefined {
  const out: SetupChoice[] = [];
  for (const word of args.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    const found = SETUP_CHOICES.find((c) => c.words.includes(word));
    if (!found) return undefined;
    if (!out.includes(found.id)) out.push(found.id);
  }
  return out;
}

export interface SetupNames {
  readonly instructionsFile: string;
  readonly localInstructionsFile: string;
  readonly projectDir: string;
  /** Settings files of the shared project and of the person, relative to the project root (RG-01). */
  readonly projectSettings: string;
  readonly localSettings: string;
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{\{([A-Z_]+)\}\}/g, (all, name: string) => values[name] ?? all);

/** § 5.3 (first version) or FA-01 (guided version, EF-03: only the phases of the chosen elements). */
export function createInstructionsRequest(names: SetupNames, guided: boolean, choices: readonly SetupChoice[]): string {
  const values = { INSTRUCTIONS_FILE: names.instructionsFile, LOCAL_INSTRUCTIONS_FILE: names.localInstructionsFile, PROJECT_DIR: names.projectDir };
  if (!guided) return fill(firstVersion, values).trimEnd();
  const has = (c: SetupChoice) => choices.includes(c);
  const phases = [
    "Explore the repository: build files, scripts, tests, CI, documentation, existing instructions, skills and settings.",
    "Ask the questions the repository does not answer, then propose what you intend to create.",
    ...(has("project") ? [`Write the project instructions \`${names.instructionsFile}\`, shared with the team.`] : []),
    ...(has("personal") ? [`Write the personal instructions \`${names.localInstructionsFile}\`, for this user only and kept out of version control.`] : []),
    ...(has("skills") ? [`Create skills for the workflows that recur in this project, each in \`${names.projectDir}/skills/<name>/definition.md\` with a front matter giving its \`name\` and \`description\`.`] : []),
    ...(has("hooks")
      ? [
          `Propose hooks for the optimisations that fit (formatting on save, static analysis, tools of the forge), written to the settings file of the scope the user chooses: \`${names.projectSettings}\` (shared project) or \`${names.localSettings}\` (personal). Recall that a hook runs code at each event.`,
        ]
      : []),
    "Summarise.",
  ];
  const chosen = SETUP_CHOICES.filter((c) => has(c.id)).map((c) => c.id.replace("project", "project instructions").replace("personal", "personal instructions"));
  return fill(guidedVersion, { ...values, CHOSEN: chosen.join(", "), PHASES: phases.map((p, i) => `${i + 1}. ${p}`).join("\n") }).trimEnd();
}
