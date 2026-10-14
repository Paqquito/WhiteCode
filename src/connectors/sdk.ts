// Implements: SPEC-MCP-005 (CA-01/02, EF-01/02/03, RG-01).
// Supports: gap E-171 (session declarations over the existing control channel).
import { connectorTool, qualifiedToolName, schemaProblem } from "./tools";
import type { McpCallResult, McpToolInfo } from "./stdio-client";
import { RequestTimeout } from "./stdio-client";
import type { ControlChannel } from "../control/channel";
export interface SdkServer { readonly name: string; readonly tools: readonly McpToolInfo[] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function parseSdkServers(value: unknown): readonly SdkServer[] {
  if (!Array.isArray(value) || value.length > 16 || JSON.stringify(value).length > 131072) throw new Error("sdkServers : au plus 16 serveurs et 128 Kio attendus.");
  const servers: SdkServer[] = [], names = new Set<string>(); let count = 0;
  for (const server of value) {
    if (!object(server) || typeof server["name"] !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(server["name"]) || names.has(server["name"]) || !Array.isArray(server["tools"])) throw new Error("Déclaration de serveur de kit invalide.");
    names.add(server["name"]); const tools: McpToolInfo[] = [], taken = new Set<string>();
    for (const tool of server["tools"]) {
      if (++count > 64 || !object(tool) || typeof tool["name"] !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(tool["name"]) || taken.has(tool["name"]) || tool["description"] !== undefined && (typeof tool["description"] !== "string" || tool["description"].length > 4000) || schemaProblem(tool["inputSchema"])) throw new Error("Déclaration d’outil de kit invalide.");
      const annotations = tool["annotations"];
      if (annotations !== undefined && (!object(annotations) || Object.entries(annotations).some(([key, value]) => !["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].includes(key) || typeof value !== "boolean"))) throw new Error("Annotations de kit invalides.");
      taken.add(tool["name"]); tools.push({ name: tool["name"], description: tool["description"] as string | undefined, inputSchema: tool["inputSchema"] as Record<string, unknown>, ...(annotations ? { annotations } : {}) });
    }
    servers.push({ name: server["name"], tools });
  }
  return servers;
}
export function sdkTools(servers: readonly SdkServer[], channel: ControlChannel, options: { timeoutMs: number; descriptionMax: number; outputLimit: number; estimateTokens: (text: string) => number; store: (key: string, text: string) => string; redact: (text: string) => string; taken?: ReadonlySet<string> }) {
  const taken = new Set(options.taken);
  return servers.flatMap(server => server.tools.map(info => {
    const name = qualifiedToolName(server.name, info.name, taken); if (taken.has(name)) throw new Error("SDK tool name collision."); taken.add(name);
    return connectorTool(info, name, { ...options, server: server.name, overflowed: () => {}, call: async (name, args, scope): Promise<McpCallResult> => {
      const timeout = AbortSignal.timeout(options.timeoutMs), signal = AbortSignal.any([scope.signal, timeout]);
      const answer = await channel.demand("sdk_mcp_request", { server: server.name, method: "tools/call", params: { name, arguments: args } }, signal);
      if (!scope.signal.aborted && (timeout.aborted || answer.kind === "timeout")) throw new RequestTimeout("The application did not answer before the SDK tool timeout.");
      if (answer.kind !== "answer" || !answer.ok) throw new Error(`Application connector unavailable: ${answer.kind}.`);
      const result = answer.result;
      if (!object(result) || !Array.isArray(result["content"]) || result["content"].length > 256 || result["content"].some(part => !object(part) || (part["type"] === "text" ? typeof part["text"] !== "string" : part["type"] === "image" ? typeof part["data"] !== "string" || typeof part["mimeType"] !== "string" : part["type"] === "resource_link" ? typeof part["uri"] !== "string" : part["type"] === "resource" ? !object(part["resource"]) || typeof part["resource"]["uri"] !== "string" || typeof part["resource"]["text"] !== "string" && typeof part["resource"]["blob"] !== "string" : true)) || result["isError"] !== undefined && typeof result["isError"] !== "boolean") throw new Error("Invalid application MCP response.");
      return result as unknown as McpCallResult;
    } });
  }));
}
