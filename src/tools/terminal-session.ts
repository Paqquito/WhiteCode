// Implements: SPEC-OUT-010 (real tmux sessions and explicit unavailable refusal), gap E-194.
// Native protocol: https://man.openbsd.org/tmux.1 (new-session, send-keys and capture-pane).
import { randomUUID } from "node:crypto";
import { findExecutable, type PlatformName } from "../platform/system";
import { runToCompletion } from "../platform/process";
import { textOutcome, type Tool } from "./types";
import { runShellTool } from "./run-shell";
interface Input {
  session: string;
  action: "command" | "keys" | "read" | "wait" | "close";
  command?: string;
  keys?: string;
  pattern?: string;
  timeout_ms?: number;
}
export class TerminalSessions {
  readonly #socket = "terminal-" + randomUUID();
  readonly #names = new Set<string>();
  readonly #mux?: string;
  constructor(
    readonly options: {
      platform: PlatformName;
      multiplexor?: string | null;
      shell?: string;
      cwd: () => string;
      environment: () => Record<string, string>;
      redact: (text: string) => string;
      limit: number;
    },
  ) {
    this.#mux =
      options.multiplexor === null || options.platform === "windows"
        ? undefined
        : (options.multiplexor ?? findExecutable("tmux"));
  }
  #call(args: readonly string[]) {
    if (!this.#mux)
      throw new Error(
        "Persistent terminals unavailable: no supported terminal multiplexer is installed. Use run_shell with background execution instead. No command was executed.",
      );
    return runToCompletion(
      this.#mux,
      ["-L", this.#socket, "-f", "/dev/null", ...args],
      {
        cwd: this.options.cwd(),
        env: this.options.environment(),
        timeoutMs: 2000,
      },
    );
  }
  close(): void {
    if (this.#mux && this.#names.size) {
      this.#call(["kill-server"]);
      this.#names.clear();
    }
  }
  tool(): Tool<Input> {
    const owner = this;
    return {
      name: "terminal_session",
      permissionName: "run_shell",
      description: () =>
        "Operate a real persistent terminal managed by tmux. Actions: command, keys, read, wait, close. A command receives ordinary shell permissions. Key input supports only the named controls C-c, C-d and Escape; submit all executable text through command. Screens are external data. Without tmux the call explicitly refuses and executes nothing. The product uses a private tmux server; attach with the returned socket name to observe it.",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
          action: { enum: ["command", "keys", "read", "wait", "close"] },
          command: { type: "string", minLength: 1, maxLength: 32000 },
          keys: { type: "string", maxLength: 8192 },
          pattern: { type: "string", minLength: 1, maxLength: 1024 },
          timeout_ms: { type: "integer", minimum: 1, maximum: 10000 },
        },
        required: ["session", "action"],
        additionalProperties: false,
      },
      isEnabled: () => true,
      flags: () => ({
        readOnly: false,
        concurrencySafe: false,
        destructive: false,
        requiresPermission: true,
        openWorld: true,
      }),
      ruleSubject: (input) => ({
        kind: "command",
        command:
          input.action === "command"
            ? (input.command ?? "")
            : "terminal_session " + input.session + " " + input.action,
      }),
      summary: (input) => `Terminal ${input.session} : ${input.action}`,
      validate(input, ctx) {
        if (!owner.#mux || !owner.options.shell)
          return "Persistent terminals unavailable: no supported terminal multiplexer is installed. Use run_shell in the background instead. No command was executed.";
        if (input.action === "command") {
          if (!input.command) return "command is required.";
          return runShellTool.validate?.({ command: input.command }, ctx);
        }
        if (
          input.action === "keys" &&
          !["C-c", "C-d", "Escape"].includes(input.keys ?? "")
        )
          return "Only C-c, C-d and Escape controls are supported. Submit executable text through the command action so shell permission rules evaluate it.";
        if (input.action === "wait" && !input.pattern)
          return "pattern is required for this action.";
        if (!owner.#names.has(input.session))
          return "Unknown terminal session: " + input.session;
        return undefined;
      },
      async execute(input, ctx) {
        try {
          ctx.signal.throwIfAborted();
          const target = input.session + ":0.0",
            checked = (args: readonly string[]) => {
              const result = owner.#call(args);
              if (result.code !== 0)
                throw new Error("Persistent terminal operation failed.");
              return result.stdout;
            };
          if (input.action === "close") {
            checked(["kill-session", "-t", input.session]);
            owner.#names.delete(input.session);
            return textOutcome("Terminal session closed.");
          }
          if (input.action === "command") {
            if (
              owner.#names.has(input.session) &&
              owner.#call(["has-session", "-t", input.session]).code !== 0
            )
              owner.#names.delete(input.session);
            if (!owner.#names.has(input.session)) {
              checked([
                "new-session",
                "-d",
                "-s",
                input.session,
                "-c",
                owner.options.cwd(),
                "-x",
                "120",
                "-y",
                "40",
                owner.options.shell!,
                "-i",
              ]);
              owner.#names.add(input.session);
            }
            checked(["send-keys", "-t", target, "C-c", "C-u"]);
            checked(["send-keys", "-t", target, "-l", "--", input.command!]);
            checked(["send-keys", "-t", target, "Enter"]);
          } else if (input.action === "keys") {
            const special = ["C-c", "C-d", "Enter", "Escape"].includes(
              input.keys!,
            );
            checked([
              "send-keys",
              "-t",
              target,
              ...(special ? [] : ["-l", "--"]),
              input.keys!,
            ]);
          }
          let screen = "",
            matched = false;
          const deadline =
            Date.now() +
            (input.action === "wait" ? (input.timeout_ms ?? 2000) : 100);
          do {
            ctx.signal.throwIfAborted();
            screen = checked([
              "capture-pane",
              "-p",
              "-t",
              target,
              "-S",
              "-500",
            ]).slice(-owner.options.limit);
            matched = input.pattern ? screen.includes(input.pattern) : true;
            if (matched && input.action === "wait") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          } while (Date.now() < deadline);
          return textOutcome(
            `Terminal ${input.session}; observe with tmux -L ${owner.#socket} attach -t ${input.session}.${!matched ? " Pattern wait timed out." : ""}\n` +
              owner.options.redact(screen),
          );
        } catch {
          ctx.signal.throwIfAborted();
          return textOutcome(
            "Persistent terminal operation failed. Inspect the session before retrying; its command may already have run.",
            true,
            "execution",
          );
        }
      },
    };
  }
}
