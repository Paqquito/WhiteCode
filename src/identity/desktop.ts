// Supports: SPEC-CAD-002 (build-time desktop modules and extension catalogues).
export interface DesktopIdentity {
  readonly extensionCatalogs: readonly { readonly repository: string; readonly ref: string }[];
  readonly modules: readonly string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Optional build inputs for a desktop distribution. Existing CLI identities omit this section. */
export function readDesktopIdentity(input: unknown): DesktopIdentity | undefined {
  if (!object(input) || Object.keys(input).some(key => key !== "modules" && key !== "extensionCatalogs")) return;
  const { modules = [], extensionCatalogs: catalogs = [] } = input;
  if (!Array.isArray(modules) || modules.length > 32 || new Set(modules).size !== modules.length ||
      !modules.every(id => typeof id === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(id))) return;
  if (!Array.isArray(catalogs) || catalogs.length > 16) return;
  const extensionCatalogs: { repository: string; ref: string }[] = [];
  for (const entry of catalogs) {
    if (!object(entry) || Object.keys(entry).some(key => key !== "repository" && key !== "ref") ||
        typeof entry.repository !== "string" || typeof entry.ref !== "string" ||
        !/^[\w][\w./-]{0,199}$/.test(entry.ref) || entry.ref.includes("..")) return;
    let url: URL;
    try { url = new URL(entry.repository); } catch { return; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
        url.pathname === "/" || extensionCatalogs.some(item => item.repository === url.href)) return;
    extensionCatalogs.push({ repository: url.href, ref: entry.ref });
  }
  return { modules, extensionCatalogs };
}
