// Implements: SPEC-PER-001 (qualified installed-extension hooks and revocation on every installation).
import { join, dirname } from "node:path";
import type { Settings } from "../config/settings";
import { readPrivateText } from "../shared/private-text";
import { isWithin, realPathOrSelf } from "../platform/system";
import type { ExtensionContributions, ActiveExtension } from "./load";

export function extensionDecisionHooks(options: {
  settings: Settings;
  configDir: string;
  active: readonly ActiveExtension[];
  contributions: ExtensionContributions;
  projects: readonly string[];
}) {
  const eligible = new Set<string>();
  const sources = options.contributions.hookSources.map((source) => {
    const id = source.labelScope,
      active = options.active.find(
        (item) => item.id === id && item.origin === "installed",
      );
    if (
      !active ||
      !isWithin(
        realPathOrSelf(active.root),
        join(options.configDir, "extensions"),
      ) ||
      !isWithin(realPathOrSelf(source.file), realPathOrSelf(active.root)) ||
      options.projects.some((project) =>
        isWithin(realPathOrSelf(source.file), realPathOrSelf(project)),
      )
    )
      return source;
    const origin = options.settings
      .valuesByScope("extensions.enabled")
      .filter(
        (layer) => (layer.value as Record<string, unknown>)[id] !== undefined,
      )
      .at(-1);
    if (
      !origin ||
      !["user", "managed"].includes(origin.origin) ||
      (origin.value as Record<string, unknown>)[id] !== true
    )
      return source;
    try {
      const marker = join(dirname(active.root), ".installation-id"),
        installation = readPrivateText(marker, 128);
      if (!/^[a-f0-9-]{36}$/.test(installation)) return source;
      eligible.add(source.file);
      return {
        ...source,
        installation,
        authorityCurrent: () => {
          try {
            return readPrivateText(marker, 128) === installation;
          } catch {
            return false;
          }
        },
      };
    } catch {
      return source;
    }
  });
  return { sources, eligible };
}
