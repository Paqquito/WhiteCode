// Implements: SPEC-MCP-001 (§ 5.1 locations of each scope, `--connectors`, FA-01), SPEC-PER-019 (§ 5.3 step 3, FA-01, FA-02, EF-01, EF-02, RG-01),
//             SPEC-CFG-010 (choices by project in the user state)
// Where the connectors of a session come from, and which project connectors are approved.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { comparablePath, type PlatformName } from "../platform/system";
import type { ConnectorDeclaration, ConnectorSource, ProjectChoice } from "./declarations";

/** Choices of the user for one project (SPEC-CFG-010): personal connectors (`local` scope) and project connector approvals. */
export interface ProjectState {
  readonly connectors?: Record<string, unknown>;
  readonly connectorChoices?: Readonly<Record<string, { readonly decision: "approved" | "refused"; readonly fingerprint: string }>>;
}

export const USER_CONNECTORS_FILE = "connectors.json";
export const MANAGED_CONNECTORS_FILE = "policy-connectors.json";

/** Key of a project in the user state. */
export function projectStateKey(projectRoot: string, platform: PlatformName): string {
  return comparablePath(projectRoot, platform);
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export interface SourceInputs {
  readonly configDir: string;
  readonly managedDir: string;
  readonly projectRoot: string;
  readonly projectDirName: string;
  /** Project connectors are read only for a trusted project (SPEC-PER-016). */
  readonly projectTrusted: boolean;
  readonly projectState: ProjectState | undefined;
  /** Values of `--connectors`: a path or JSON content each. */
  readonly cliValues: readonly string[];
  readonly cwd: string;
}

/** § 5.1 of SPEC-MCP-001: managed, user, project, local (user state) and the `--connectors` options. */
export function connectorSources(i: SourceInputs): ConnectorSource[] {
  const sources: ConnectorSource[] = [];
  const managed = join(i.managedDir, MANAGED_CONNECTORS_FILE);
  sources.push({ scope: "managed", source: managed, content: readText(managed) });
  const user = join(i.configDir, USER_CONNECTORS_FILE);
  sources.push({ scope: "user", source: user, content: readText(user) });
  if (i.projectTrusted) {
    const project = join(i.projectRoot, i.projectDirName, USER_CONNECTORS_FILE);
    sources.push({ scope: "project", source: project, content: readText(project) });
    if (i.projectState?.connectors) sources.push({ scope: "local", source: "état utilisateur (entrée du projet)", content: i.projectState.connectors });
  }
  i.cliValues.forEach((value, n) => {
    const inline = value.trim().startsWith("{");
    const path = inline ? `--connectors #${n + 1}` : isAbsolute(value) ? value : resolve(i.cwd, value);
    const content = inline ? value : readText(path);
    sources.push({ scope: "cli", source: path, content: content ?? "" });
  });
  return sources;
}

export interface ApprovalInputs {
  readonly projectState: ProjectState | undefined;
  /** `mcp.enableProjectServers`: every project connector approved (explicit setting of the user, FA-02). */
  readonly enableAll: boolean;
  /** `mcp.enabledProjectServers`, `mcp.disabledProjectServers`. */
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
}

/**
 * SPEC-PER-019: a project connector starts only once approved: by a remembered choice bound to its fingerprint (RG-01;
 * a changed declaration needs a new approval, FA-01), or by the explicit settings of the user (FA-02).
 */
export function projectChoice(i: ApprovalInputs): (d: ConnectorDeclaration) => ProjectChoice {
  return (d) => {
    if (i.disabled.includes(d.name)) return "refused";
    const remembered = i.projectState?.connectorChoices?.[d.name];
    if (remembered?.decision === "refused" && remembered.fingerprint === d.fingerprint) return "refused";
    if (remembered?.decision === "approved" && remembered.fingerprint === d.fingerprint) return "approved";
    if (i.enableAll || i.enabled.includes(d.name)) return "approved";
    return remembered ? "modified" : "pending";
  };
}
