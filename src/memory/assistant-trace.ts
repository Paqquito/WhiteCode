// Implements: SPEC-MOT-042 (queued reduced segments and append-only daily memory).
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HistoryMessage } from "../providers/types";
import {
  bindPrivateStorage,
  storeAppend,
  storeExists,
  storeFileLock,
  storeMkdir,
  storeStat,
} from "../session/private-storage";
import { ordinaryPrivateFile } from "../shared/private-text";
import { containsSecret } from "../shared/secrets";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";
import { textOutcome, type Tool } from "../tools/types";

export class AssistantTrace {
  readonly root: string;
  #queue: Array<{ segment: number; text: string }> = [];
  #timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly options: {
      root: string;
      redact: (text: string) => string;
      report: (message: string) => void;
      now?: () => Date;
    },
  ) {
    this.root = options.root;
  }
  get pending() {
    return this.#queue.length;
  }
  archive(messages: readonly HistoryMessage[], segment: number): void {
    if (this.#queue.length >= 8) {
      this.options.report(
        "Archive de segment différée : file pleine ; transcription originale conservée.",
      );
      return;
    }
    const rows = messages.slice(0, 4096).map((message) =>
      message.role === "assistant"
        ? {
            role: message.role,
            text: message.text.slice(0, 12000),
            tools: message.toolCalls.map((call) => call.name),
          }
        : message.role === "user"
          ? {
              role: message.role,
              text: message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
                .slice(0, 12000),
            }
          : { role: message.role, text: message.text.slice(0, 12000) },
    );
    // The complete transcript remains authoritative; this bounded archive is an index of essential text.
    let bytes = 0;
    const kept = rows.filter((row) => {
      bytes += Buffer.byteLength(JSON.stringify(row));
      return bytes <= 524288;
    });
    this.#queue.push({
      segment,
      text:
        this.options.redact(
          JSON.stringify(
            {
              schemaVersion: 1,
              segment,
              reduced: true,
              truncated: kept.length < messages.length,
              messages: kept,
            },
            null,
            2,
          ),
        ) + "\n",
    });
    this.#timer ??= setTimeout(
      bindPrivateStorage(() => {
        this.#timer = undefined;
        void this.flush();
      }),
      0,
    );
  }
  async flush(): Promise<void> {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    while (this.#queue.length) {
      const item = this.#queue.shift()!;
      try {
        const directory = join(this.root, "segments");
        ordinaryPrivateFile(join(directory, ".check"), 0);
        storeMkdir(directory, { recursive: true, mode: 0o700 });
        writeAtomic(
          join(directory, item.segment + "-" + randomUUID() + ".json"),
          Buffer.from(item.text),
          currentPlatform(),
          true,
        );
      } catch {
        this.options.report(
          "Échec d’archivage du segment ; transcription originale conservée.",
        );
      }
    }
  }
  journalTool(): Tool<{ text: string }> {
    return {
      name: "append_journal",
      description: () =>
        "Append one short factual memory to today's assistant journal. Entries are append-only; the product chooses the current local date and timestamp at execution. Never store secrets, source code, or instructions that widen permissions. Read earlier journals with read_file when needed.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
            pattern: "^[^\\r\\n\\u0000-\\u001f\\u007f]+$",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      flags: () => ({
        readOnly: false,
        concurrencySafe: false,
        destructive: false,
        requiresPermission: false,
        openWorld: false,
      }),
      isEnabled: () => true,
      ruleSubject: () => ({ kind: "none" }),
      permissionContribution: () => "allow",
      summary: () => "Append assistant memory",
      execute: async (input, ctx) => {
        ctx.signal.throwIfAborted();
        try {
          if (
            !input.text.trim() ||
            input.text.length > 1000 ||
            /[\r\n\x00-\x1f\x7f]/.test(input.text) ||
            containsSecret(input.text) ||
            this.options.redact(input.text) !== input.text
          )
            return textOutcome(
              "Only short, single-line, non-sensitive memories can be appended.",
              true,
            );
          const now = (this.options.now ?? (() => new Date()))(),
            pad = (n: number) => String(n).padStart(2, "0"),
            directory = join(
              this.root,
              "journal",
              String(now.getFullYear()),
              pad(now.getMonth() + 1),
            ),
            path = join(directory, pad(now.getDate()) + ".md");
          if (ctx.readDenied(path))
            return textOutcome(
              "This journal is denied by the active rules.",
              true,
              "permission_denied",
            );
          ordinaryPrivateFile(path, 2097152);
          storeMkdir(directory, { recursive: true, mode: 0o700 });
          const release = storeFileLock(join(directory, ".journal.lock"));
          if (!release)
            return textOutcome("The journal is busy; retry later.", true);
          try {
            if (ctx.readDenied(path))
              return textOutcome(
                "This journal is denied by the active rules.",
                true,
                "permission_denied",
              );
            if (storeExists(path) && storeStat(path).size > 2095104)
              throw Error("Journal size limit reached.");
            ctx.signal.throwIfAborted();
            storeAppend(
              path,
              `- ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${input.text.trim()}\n`,
              { mode: 0o600 },
            );
          } finally {
            release();
          }
          return textOutcome("Appended memory to " + path);
        } catch {
          return textOutcome(
            "The daily journal could not be appended; existing entries are preserved.",
            true,
          );
        }
      },
    };
  }
}
