// Implements: SPEC-PER-021 (EF-01, EF-02, CA-01), SPEC-CFG-003 (FA-04), gap E-129.
// A bounded paged review before session composition; pasted input cannot grant consent.
import type { Terminal } from "../platform/terminal";
import type { PolicyConsentProposal } from "../config/policy-consent";
import { policyConsentText } from "../config/policy-consent";
import { KeyParser, type InputEvent } from "../ui/keys";
import { spansToLines, wrapLine } from "../ui/text";

export function askPolicyConsent(terminal: Terminal, proposal: PolicyConsentProposal, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const parser = new KeyParser();
    const content = spansToLines([{ text: policyConsentText(proposal) }]);
    let rows = Math.max(1, terminal.rows - 5);
    let lines: string[] = [];
    const reflow = () => {
      rows = Math.max(1, terminal.rows - 5);
      lines = content.flatMap((line) => wrapLine(line, Math.max(1, terminal.columns - 1))).map((line) => line.map((cell) => cell.ch).join(""));
    };
    reflow();
    let offset = 0;
    let seenEnd = false;
    let drawn = 0;
    let armedAt = Date.now() + 350;
    let finished = false;
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;
    const adequate = () => terminal.columns >= 92 && terminal.rows >= 8;
    const draw = () => {
      if (drawn > 0) terminal.write(`\u001b[${drawn}F\u001b[J`);
      const page = adequate() ? lines.slice(offset, offset + rows) : [];
      if (adequate()) seenEnd ||= offset + rows >= lines.length;
      const output = adequate() ? [...page, "", `Lignes ${offset + 1} à ${Math.min(lines.length, offset + rows)} sur ${lines.length} — flèches pour lire`,
        seenEnd ? "o : accepter ce contenu · n ou Échap : refuser" : "Lire la dernière page avant d'accepter · n ou Échap : refuser"] : ["Agrandir : 92 × 8 minimum. n/Échap : refuser".slice(0, Math.max(1, terminal.columns - 1))];
      terminal.write(output.join("\r\n") + "\r\n");
      drawn = output.length;
    };
    const finish = (accepted: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(escapeTimer);
      unsubscribe();
      unsubscribeResize();
      unsubscribeExit();
      signal?.removeEventListener("abort", abort);
      terminal.write("\u001b[?2004l");
      terminal.setRawMode(false);
      resolve(accepted);
    };
    const abort = () => finish(false);
    terminal.setRawMode(true);
    terminal.write("\u001b[?2004h");
    const handle = (events: readonly InputEvent[]) => {
      for (const event of events) {
        if (event.kind !== "key") continue;
        if(event.phase==="release")continue;
        if (event.ctrl && ["c", "d"].includes(event.name)) return finish(false);
        if (Date.now() < armedAt) continue;
        if (["escape", "n"].includes(event.name)) return finish(false);
        if (event.name === "o" && !event.ctrl && !event.alt && seenEnd && adequate()) return finish(true);
        if (["down", "pagedown", "end"].includes(event.name)) offset = Math.min(Math.max(0, lines.length - rows), offset + rows);
        else if (["up", "pageup", "home"].includes(event.name)) offset = Math.max(0, offset - rows);
        else continue;
        armedAt = Date.now() + 350;
        draw();
      }
    };
    const unsubscribe = terminal.onInput((data) => {
      clearTimeout(escapeTimer);
      handle(parser.feed(data));
      if (!finished && parser.pendingEscape) escapeTimer = setTimeout(() => handle(parser.flush()), 30);
    });
    const unsubscribeResize = terminal.onResize(() => {
      reflow();
      offset = 0;
      seenEnd = false;
      armedAt = Date.now() + 350;
      draw();
    });
    const unsubscribeExit = terminal.onProcessExit(abort);
    signal?.addEventListener("abort", abort, { once: true });
    draw();
    if (signal?.aborted) abort();
  });
}
