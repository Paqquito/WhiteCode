// Implements: SPEC-MOD-021, SPEC-MOD-022, SPEC-PER-001 (supervision and pending human decisions).
import { randomUUID } from "node:crypto";
import { startChild, type Child } from "../platform/process";
import { StringDecoder } from "node:string_decoder";
import type { JobRestrictions } from "./jobs";
export interface WorkMessage {
  readonly id: string;
  readonly text: string;
}
export interface WorkerRecord {
  readonly id: string;
  readonly kind: "assistant" | "background" | "job";
  readonly cwd: string;
  readonly createdAt: number;
  readonly mode: "ask" | "no_prompt";
  readonly template?: string;
  readonly jobRestrictions?: JobRestrictions;
  status:
    | "starting"
    | "running"
    | "waiting"
    | "idle"
    | "completed"
    | "stopped"
    | "error";
  summary: string;
  restarts: number;
  pending: WorkMessage[];
}
interface PendingApproval {
  readonly id: string;
  readonly demand: string;
  readonly params: Record<string, unknown>;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
}
export class ResidentWorker {
  #child?: Child;
  #closed = false;
  #epoch = randomUUID();
  #partial = "";
  #inflight?: string;
  #sequence = 0;
  #events: Array<{ sequence: number; event: Record<string, unknown> }> = [];
  #eventBytes = 0;
  #approvals = new Map<string, PendingApproval>();
  #restart?: ReturnType<typeof setTimeout>;
  #decoder = new StringDecoder("utf8");
  #launchedAt = 0;
  #closing?: Promise<void>;
  constructor(
    readonly record: WorkerRecord,
    readonly options: {
      command: (record: WorkerRecord) => { file: string; args: string[] };
      environment: (record: WorkerRecord) => Record<string, string>;
      persist: () => void;
      assertPolicy: () => void;
      waitMs: number;
      completed: (record: WorkerRecord) => void;
      error: (message: string) => void;
      waiting?: (record: WorkerRecord) => void;
      wasAccepted: (record: WorkerRecord, id: string) => boolean;
    },
  ) {}
  get pid() {
    return this.#child?.pid;
  }
  get approvals() {
    return [...this.#approvals.values()].map(
      ({ timer: _timer, ...value }) => value,
    );
  }
  events(after: number) {
    const rows: Array<{ sequence: number; event: Record<string, unknown> }> =
      [];
    let bytes = 0;
    for (const item of this.#events) {
      if (item.sequence <= after) continue;
      const size = Buffer.byteLength(JSON.stringify(item));
      if (rows.length && bytes + size > 262144) break;
      if (size > 262144) {
        rows.push({
          sequence: item.sequence,
          event: {
            type: "error",
            message:
              "Un événement volumineux est disponible dans le journal de la session.",
          },
        });
        break;
      }
      rows.push(item);
      bytes += size;
    }
    return rows;
  }
  get latestSequence() {
    return this.#sequence;
  }
  #publish(event: Record<string, unknown>) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > 1048576) return;
    this.#events.push({ sequence: ++this.#sequence, event });
    this.#eventBytes += bytes;
    while (this.#events.length > 2048 || this.#eventBytes > 8388608)
      this.#eventBytes -= Buffer.byteLength(
        JSON.stringify(this.#events.shift()!.event),
      );
  }
  #send(message: Record<string, unknown>) {
    this.#child?.input?.write(JSON.stringify(message) + "\n");
  }
  launch(): void {
    if (this.#closed) return;
    this.options.assertPolicy();
    this.#epoch = randomUUID();
    this.#partial = "";
    this.#inflight = undefined;
    this.#decoder = new StringDecoder("utf8");
    this.#launchedAt = Date.now();
    this.record.status = "starting";
    this.options.persist();
    const command = this.options.command(this.record),
      epoch = this.#epoch;
    const child = startChild(command.file, command.args, {
      cwd: this.record.cwd,
      env: this.options.environment(this.record),
      keepInputOpen: true,
      onData: (chunk) => {
        if (this.#epoch === epoch)
          try {
            this.#receive(chunk);
          } catch {
            this.options.error("Worker state publication failed.");
            void this.#child?.killTree(100);
          }
      },
      onErrorData: () => {},
    });
    this.#child = child;
    this.#send({
      type: "control_init",
      protocolVersion: "1.0",
      decisionAuthority: true,
      demands: ["approval_request", "notify"],
    });
    void child.exited
      .then(() => {
        if (this.#epoch !== epoch) return;
        this.#child = undefined;
        this.#clearApprovals();
        if (this.#closed) return;
        this.record.restarts =
          Date.now() - this.#launchedAt > 60000 ? 1 : this.record.restarts + 1;
        if (this.record.restarts > 5) {
          this.record.status = "error";
          this.options.persist();
          return;
        }
        this.record.status = "starting";
        this.options.persist();
        this.#restart = setTimeout(
          () => {
            try {
              this.launch();
            } catch {
              this.record.status = "error";
              try {
                this.options.persist();
              } catch {
                this.options.error(
                  "Worker restart state could not be persisted.",
                );
              }
            }
          },
          Math.min(30000, 1000 * 2 ** (this.record.restarts - 1)),
        );
      })
      .catch(() => this.options.error("Worker supervision failed."));
  }
  #receive(chunk: Buffer) {
    this.#partial += this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#partial) > 1048576) {
      void this.#child?.killTree(100);
      return;
    }
    for (let end; (end = this.#partial.indexOf("\n")) !== -1;) {
      const line = this.#partial.slice(0, end);
      this.#partial = this.#partial.slice(end + 1);
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw Error();
        event = parsed as Record<string, unknown>;
      } catch {
        void this.#child?.killTree(100);
        return;
      }
      this.#publish(event);
      if (event["type"] === "session") {
        this.record.status = "idle";
        this.options.persist();
        this.#next();
      }
      if (
        event["type"] === "progress_summary" &&
        typeof event["text"] === "string"
      ) {
        this.record.summary = event["text"].slice(0, 1600);
        this.options.persist();
      }
      if (
        event["type"] === "control_request" &&
        typeof event["id"] === "string"
      ) {
        if (event["request"] === "notify") {
          this.#send({
            type: "control_response",
            id: event["id"],
            ok: true,
            result: {},
          });
          continue;
        }
        const params = event["params"];
        const valid =
          !!params &&
          typeof params === "object" &&
          !Array.isArray(params) &&
          typeof (params as Record<string, unknown>)["summary"] === "string";
        if (
          event["request"] !== "approval_request" ||
          !valid ||
          event["truncated"] === true ||
          Buffer.byteLength(JSON.stringify(params)) > 65536 ||
          this.record.mode === "no_prompt" ||
          (params as Record<string, unknown> | undefined)?.["approvalMode"] ===
            "no_prompt" ||
          this.#approvals.size >= 8
        ) {
          this.#send({
            type: "control_response",
            id: event["id"],
            ok: true,
            result: {
              decision: "deny",
              reason:
                "No authorized human is available or the approval payload is incomplete.",
            },
          });
          continue;
        }
        const id = this.#epoch + ":" + event["id"],
          expiresAt = Date.now() + this.options.waitMs;
        const timer = setTimeout(() => {
          this.answer(id, false);
        }, this.options.waitMs);
        this.#approvals.set(id, {
          id,
          demand: event["id"],
          params: event["params"] as Record<string, unknown>,
          expiresAt,
          timer,
        });
        this.record.status = "waiting";
        this.options.persist();
        this.options.waiting?.(this.record);
      }
      if (event["type"] === "turn_completed") {
        this.#clearApprovals();
        if (this.#inflight && this.record.pending[0]?.id === this.#inflight)
          this.record.pending.shift();
        this.#inflight = undefined;
        this.record.status =
          this.record.kind === "background" && !this.record.pending.length
            ? "completed"
            : "idle";
        this.options.persist();
        this.options.completed(this.record);
        if (this.record.status === "completed") void this.close(false);
        else this.#next();
      }
    }
  }
  enqueue(text: string): string {
    if (
      this.#closed ||
      !text.trim() ||
      text.length > 65536 ||
      this.record.pending.length >= 100
    )
      throw Error("File d’attente pleine ou travail indisponible.");
    const message = { id: randomUUID(), text };
    this.record.pending.push(message);
    try {
      this.options.persist();
    } catch (error) {
      this.record.pending.pop();
      throw error;
    }
    this.#next();
    return message.id;
  }
  #next() {
    if (
      this.#closed ||
      !this.#child ||
      this.#inflight ||
      this.record.status !== "idle"
    )
      return;
    const message = this.record.pending[0];
    if (!message) return;
    this.options.assertPolicy();
    this.#inflight = message.id;
    this.record.status = "running";
    this.options.persist();
    const content = this.options.wasAccepted(this.record, message.id)
      ? `Continue the previously accepted request marked ${message.id}. Check the prior effects before repeating any action.`
      : `[accepted-event:${message.id}]\n${message.text}`;
    this.#send({ type: "user", content });
  }
  answer(id: string, approved: boolean): boolean {
    const pending = this.#approvals.get(id);
    if (!pending) return false;
    this.#approvals.delete(id);
    clearTimeout(pending.timer);
    let allow = approved && Date.now() < pending.expiresAt;
    try {
      this.options.assertPolicy();
    } catch {
      allow = false;
    }
    this.#send({
      type: "control_response",
      id: pending.demand,
      ok: true,
      result: {
        decision: allow ? "allow" : "deny",
        ...(allow
          ? {}
          : {
              reason:
                "No valid human approval was received before the deadline.",
            }),
      },
    });
    this.record.status = this.#approvals.size ? "waiting" : "running";
    this.options.persist();
    return true;
  }
  cancel() {
    this.#send({
      type: "control_request",
      id: randomUUID(),
      request: "cancel_turn",
      params: {},
    });
  }
  #clearApprovals() {
    for (const pending of this.#approvals.values()) clearTimeout(pending.timer);
    this.#approvals.clear();
  }
  async close(stopped = true): Promise<void> {
    if (this.#closing) return this.#closing;
    return (this.#closing = this.#close(stopped));
  }
  async #close(stopped: boolean): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#restart);
    this.#clearApprovals();
    let failure: unknown;
    if (stopped) {
      this.record.status = "stopped";
      this.record.pending.length = 0;
      try {
        this.options.persist();
      } catch (error) {
        failure = error;
      }
    }
    const child = this.#child;
    this.#child = undefined;
    if (!child) {
      if (failure) throw failure;
      return;
    }
    child.input?.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1500);
        }),
      ]);
      await child.killTree(100);
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
    if (failure) throw failure;
  }
}
