// Implements: SPEC-API-011 (masked entry, first environment-key consent), SPEC-PER-027 (explicit fallback).
// Supports: gap E-135 (no history, draft, queue or transcript receives secret input).
import type { Terminal } from "../platform/terminal";
import { KeyParser, type InputEvent } from "../ui/keys";
import { sanitize } from "../ui/text";

export function authDialog(terminal: Terminal, title: string, secret: boolean, signal?: AbortSignal, afterFinish?: () => void): Promise<string | boolean | undefined> {
  const safeTitle = sanitize(title);
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const parser = new KeyParser();
    let value = "", finished = false, drawn = false;
    const armedAt = Date.now() + 350;
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      if (drawn) terminal.write("\u001b[2F\u001b[J");
      terminal.write(`${safeTitle}\r\n${secret ? "•".repeat(Math.min(60, [...value].length)) + " — Entrée : valider · Échap : annuler" : "o : accepter · n ou Entrée : refuser"}\r\n`);
      drawn = true;
    };
    const finish = (answer: string | boolean | undefined) => {
      if (finished) return;
      finished = true; clearTimeout(escapeTimer);
      unsubscribe(); exit(); signal?.removeEventListener("abort", abort);
      terminal.write("\u001b[?2004l"); terminal.setRawMode(false);
      value = ""; afterFinish?.(); resolve(answer);
    };
    const abort = () => finish(undefined);
    const handle = (events: readonly InputEvent[]) => {
      for (const event of events) {
        if (event.kind === "paste") {
          if (secret && !/[\r\n\u0000]/.test(event.text) && value.length + event.text.length <= 2048) { value += event.text; draw(); }
          continue;
        }
        if (event.kind !== "key") continue;
        if (event.name === "escape" || event.ctrl && ["c", "d"].includes(event.name)) return finish(undefined);
        if (!secret) {
          if (Date.now() < armedAt || event.ctrl || event.alt) continue;
          if (event.name === "o") return finish(true);
          if (["n", "enter"].includes(event.name)) return finish(false);
          continue;
        }
        if (event.name === "enter") { if (value) return finish(value); continue; }
        if (event.name === "backspace") value = [...value].slice(0, -1).join("");
        else if (!event.ctrl && !event.alt && event.text && !/[\u0000-\u001f\u007f]/.test(event.text) && value.length + event.text.length <= 2048) value += event.text;
        else continue;
        draw();
      }
    };
    terminal.setRawMode(true); terminal.write("\u001b[?2004h");
    const unsubscribe = terminal.onInput((data) => {
      if (!secret && !data.includes("\u001b") && [...data].length > 1) return; // An unframed paste never grants consent.
      clearTimeout(escapeTimer); handle(parser.feed(data));
      if (!finished && parser.pendingEscape) escapeTimer = setTimeout(() => handle(parser.flush()), 30);
    });
    const exit = terminal.onProcessExit(abort);
    signal?.addEventListener("abort", abort, { once: true });
    draw(); if (signal?.aborted) abort();
  });
}
