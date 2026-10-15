// Supports: SPEC-MCP-003/004 (bounded credential masking with structural protocol fields preserved), E-175.
import { ConnectionError } from "./stdio-client";
const MAX_BYTES = 8 * 1024 * 1024;
export function redactConnectorData(value: unknown, secrets: ReadonlySet<string>, metadata = false): unknown {
    if (value === undefined || secrets.size === 0) return value;
    // Match original text once: inserted markers are never input to subsequent replacements.
    const pattern = new RegExp([...secrets].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    let bytes = 0;
    const mask = (text: string): string => {
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_BYTES) throw new ConnectionError("Résultat MCP masqué trop volumineux.");
      return text.replace(pattern, (match) => {
        bytes += 10 - Buffer.byteLength(match);
        if (bytes > MAX_BYTES) throw new ConnectionError("Résultat MCP masqué trop volumineux.");
        return "[redacted]";
      });
    };
    const visit = (item: unknown, field = "", opaque = false, depth = 0): unknown => {
      if (depth > 128) throw new ConnectionError("Résultat MCP trop imbriqué.");
      if (typeof item === "string") {
        // Routing names, schema contracts and content discriminants remain protocol data.
        if (!opaque && (metadata ? field !== "description" && field !== "title" : field === "type" || field === "role" || field === "mimeType")) return item;
        return mask(item);
      }
      if (Array.isArray(item)) return item.map((v) => visit(v, field, opaque, depth + 1));
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, v]) => {
        const data = opaque || key === "structuredContent";
        return [opaque ? mask(key) : key, visit(v, key, data, depth + 1)];
      }));
      return item;
    };
    const result = visit(value);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new ConnectionError("Résultat MCP masqué trop volumineux.");
    return result;
  }
