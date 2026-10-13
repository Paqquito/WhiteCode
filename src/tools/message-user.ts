// Implements: SPEC-OUT-034 (addressed messages, explicit status and bounded readable attachments).
// Supports: SPEC-MOD-029, SPEC-PER-010, gap E-161.
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { isAbsolutePath, isWithin, realPathOrSelf } from "../platform/system";
import { ambiguousPathReason } from "../permissions/paths";
import { imageInfo } from "./image-header";
import { maskSecrets } from "../shared/secrets";
import type { ContentPart } from "../providers/types";
import { textOutcome, type Tool } from "./types";

export interface AddressedAttachment { readonly name: string; readonly content: readonly ContentPart[] }
export interface AddressedMessage { readonly message: string; readonly status: "normal" | "proactive"; readonly attachments: readonly AddressedAttachment[] }
export const BRIEF_INSTRUCTION = "Brief mode is active: address substantive replies, acknowledgements and useful progress updates to the user through message_user. Intermediate prose and tools remain in the detail view. Always provide the actual answer; a final response without this tool will be promoted so it is not lost.";

export function createMessageUserTool(options: { enabled: () => boolean; maxBytes: () => number; publish: (message: AddressedMessage) => void }): Tool<{ message: string; status: "normal" | "proactive"; attachments?: string[] }> {
  return {
    name: "message_user", description: () => "Address a concise rich-text message to the user in brief mode. Supply normal for a response or proactive for an initiative. Optional attachments must already be readable within the authorized workspace; unavailable or excessive files are omitted with a note. This tool never writes a file.",
    inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 65536 }, status: { enum: ["normal", "proactive"] }, attachments: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 4096 } } }, required: ["message", "status"], additionalProperties: false },
    flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: () => "Address a message to the user",
    async execute(input, ctx) {
      if (ctx.signal.aborted) return textOutcome("Message interrupted.", true, "interrupted");
      if (!options.enabled()) return textOutcome("Brief mode is inactive.", true, "unavailable");
      const attachments: AddressedAttachment[] = [], omitted: string[] = []; let remaining = options.maxBytes();
      for (const path of input.attachments ?? []) {
        let fd: number | undefined;
        try {
          const real = realPathOrSelf(path), readable = [...ctx.allowedDirectories, ...(ctx.extraReadableDirectories ?? [])];
          if (!isAbsolutePath(path, ctx.platform) || ambiguousPathReason(path, ctx.platform) || !readable.some(root => isWithin(path, root, ctx.platform)) || !readable.some(root => isWithin(real, root, ctx.platform)) || ctx.readDenied(path) || ctx.readDenied(real)) throw new Error("unavailable");
          const before = statSync(path); if (!before.isFile() || before.size > remaining) throw new Error("unavailable");
          fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); const opened = fstatSync(fd);
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || realPathOrSelf(path) !== real || ctx.readDenied(realPathOrSelf(path))) throw new Error("unavailable");
          const bytes = Buffer.alloc(opened.size); let offset = 0;
          while (offset < bytes.length) { const read = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) throw new Error("unavailable"); offset += read; }
          const after = fstatSync(fd); if (ctx.signal.aborted || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || realPathOrSelf(path) !== real || ctx.readDenied(realPathOrSelf(path))) throw new Error("unavailable");
          const info = imageInfo(bytes), content: ContentPart[] = info ? [{ type: "image", mediaType: info.mediaType, dataBase64: bytes.toString("base64") }] : [{ type: "text", text: maskSecrets(bytes.toString("utf8")) }];
          attachments.push({ name: basename(path), content }); remaining -= bytes.length;
        } catch { omitted.push(basename(path)); }
        finally { if (fd !== undefined) closeSync(fd); }
      }
      if (ctx.signal.aborted) return textOutcome("Message interrupted.", true, "interrupted");
      options.publish({ message: input.message, status: input.status, attachments });
      return textOutcome(`Message published.${omitted.length ? ` Attachments omitted (unavailable, unauthorized or excessive): ${omitted.join(", ")}.` : ""}`);
    },
  };
}
