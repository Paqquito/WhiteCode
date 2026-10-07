// Supports: SPEC-BLD-007 (public traceability references).
import references from "./spec-index.json";

type Reference = { obsolete: boolean; criteria: readonly string[] };
export const specIndex: ReadonlyMap<string, Reference> = new Map(Object.entries(references));
