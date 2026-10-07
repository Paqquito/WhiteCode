// Implements: SPEC-IHM-001 (§ 5.5 restoration on exit, error or signal, EF-02, RG-02, CA-04; § 5.4 resize)
// A terminal taken over by the interface: raw input, rendering, resize handling, and restoration of the state found at
// start whatever the way out (normal close, error, process exit).

import type { Terminal } from "../platform/terminal";
import type { Capabilities } from "./capabilities";
import { Screen, type Frame, type Scheduler } from "./screen";

export interface TerminalSession {
  readonly screen: Screen;
  /** Restores the terminal; idempotent. */
  close(): void;
}

export function openTerminalSession(
  terminal: Terminal,
  o: {
    readonly capabilities: Capabilities;
    readonly maxFramesPerSecond: number;
    readonly source: (size: { columns: number; rows: number }) => Frame;
    readonly scheduler?: Scheduler;
    readonly onBroken?: (error: unknown) => void;
  },
): TerminalSession {
  const screen = new Screen({ terminal, capabilities: o.capabilities, maxFramesPerSecond: o.maxFramesPerSecond, source: o.source, scheduler: o.scheduler, onBroken: o.onBroken });
  let closed = false;
  const unsubscribe: Array<() => void> = [];
  const close = () => {
    if (closed) return;
    closed = true;
    for (const u of unsubscribe.splice(0)) u();
    screen.stop();
    terminal.setRawMode(false);
  };
  terminal.setRawMode(true);
  screen.start();
  unsubscribe.push(terminal.onProcessExit(close));
  unsubscribe.push(terminal.onResize(() => screen.resized()));
  return { screen, close };
}
