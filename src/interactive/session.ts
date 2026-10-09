// Implements: SPEC-MOD-001 (§ 5.2 steps 3 to 7, § 5.4 states, FA-01, FA-02, FA-04, EF-04, EF-07, RG-01, CA-03, CA-04), SPEC-IHM-011 (§ 5.2, FA-01, FA-02, EF-02, EF-04, RG-02, CA-02, CA-04)
// The loop of the interactive session: one entry at a time, a turn at a time (RG-01). The initial request is the first
// message, commands included (EF-07); the messages queued during a turn are sent one per turn, in order; an interruption
// or an error never sends the queue by itself.
// Supports: SPEC-SES-015 (CA-02: recovery releases only the explicitly accepted message), gap E-132.

import type { TurnResult } from "../engine/events";
import type { InteractiveApp } from "./app";

export type EntryOutcome =
  /** A turn ran. */
  | { readonly kind: "turn"; readonly result: TurnResult }
  /** A command or a refusal, shown without a turn. */
  | { readonly kind: "shown" }
  | { readonly kind: "exit" };

/** What the input area knows of an entry (SPEC-IHM-010 EF-09, EF-10). */
export interface EntryMeta {
  readonly literal?: boolean;
  readonly pasted?: readonly string[];
}

export interface InteractiveLoopOptions {
  readonly app: InteractiveApp;
  readonly initialPrompt?: string;
  readonly initialMeta?: EntryMeta;
  readonly initialQueueHeld?: boolean;
  /** Handles one entry: a built-in command, a skill or command, or a message to the model. */
  readonly process: (text: string, signal: AbortSignal, meta: EntryMeta) => Promise<EntryOutcome>;
  readonly queueAutoSend: boolean;
}

export async function runInteractiveLoop(o: InteractiveLoopOptions): Promise<{ turns: number }> {
  const { app } = o;
  let pending = o.initialPrompt !== undefined && o.initialPrompt.trim() !== "" ? o.initialPrompt : undefined;
  // FA-06 of SPEC-IHM-011: a queue restored with a reopened session is never sent by itself.
  let release = false;
  let turns = 0;
  for (;;) {
    let text: string | undefined;
    let meta: EntryMeta = {};
    const holdQueue = pending !== undefined && o.initialQueueHeld === true;
    if (pending !== undefined) {
      text = pending;
      meta = o.initialMeta ?? {};
      pending = undefined;
    } else if (release && app.queue.length > 0) {
      text = app.takeQueued();
    }
    if (text === undefined) {
      const entry = await app.nextEntry();
      if (entry.kind === "exit") break;
      text = entry.text;
      meta = { literal: entry.literal, pasted: entry.pasted };
    }
    const controller = new AbortController();
    app.setQueueHeld(holdQueue);
    app.beginTurn(controller);
    let outcome: EntryOutcome;
    try {
      outcome = await o.process(text, controller.signal, meta);
    } catch (error) {
      // ERR-03: the turn fails, the session survives.
      app.endTurn({ stopCause: "error", message: (error as Error)?.message ?? String(error) });
      release = false;
      continue;
    } finally {
      app.setQueueHeld(false);
    }
    if (outcome.kind === "exit") {
      app.endTurn({ stopCause: "completed" });
      await app.requestExit();
      continue;
    }
    if (outcome.kind === "shown") {
      app.endTurn({ stopCause: "completed" });
      release = !holdQueue && o.queueAutoSend;
      continue;
    }
    turns++;
    app.endTurn(outcome.result);
    const cause = outcome.result.stopCause;
    if (holdQueue) release = false;
    else if (cause === "interrupted" && app.queue.length > 0) {
      // FA-01, EF-04, CA-04: after an interruption, the user decides what becomes of the queue.
      release = await app.confirm(`${app.queue.length} message${app.queue.length > 1 ? "s" : ""} en attente : les envoyer maintenant ?`, "envoyer", "garder en attente");
    } else if (cause !== "completed" && cause !== "interrupted" && app.queue.length > 0) {
      // FA-02: after an error, the queue is not sent by itself.
      app.notice("info", "Les messages en attente n'ont pas été envoyés : appuyez sur ↑ pour en reprendre un.");
      release = false;
    } else release = o.queueAutoSend;
  }
  return { turns };
}
