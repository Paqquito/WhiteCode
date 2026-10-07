// Supports: SPEC-IHM-001 (§ 5.4 resize, § 5.5 restoration on exit, error or signal, EF-02), SPEC-MOD-001 (§ 5.1 terminal attached)
// Runtime adapter: the real terminal of the process (raw keyboard input, dimensions, resize events, restoration hook).

export interface Terminal {
  write(data: string): void;
  readonly columns: number;
  readonly rows: number;
  /** Raw input as it arrives (keys, pasted text, escape sequences); returns an unsubscribe function. */
  onInput(listener: (data: string) => void): () => void;
  onResize(listener: () => void): () => void;
  setRawMode(on: boolean): void;
  /** Called when the process exits for any reason, uncaught error included, to restore the terminal (EF-02). */
  onProcessExit(listener: () => void): () => void;
}

/** The terminal of the process, when its input and its output are both attached to one. */
export function processTerminal(): Terminal | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return undefined;
  return {
    write: (data) => void process.stdout.write(data),
    get columns() {
      return process.stdout.columns ?? 0;
    },
    get rows() {
      return process.stdout.rows ?? 0;
    },
    onInput(listener) {
      const handler = (chunk: Buffer | string) => listener(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      process.stdin.on("data", handler);
      process.stdin.resume();
      return () => {
        process.stdin.off("data", handler);
        process.stdin.pause();
      };
    },
    onResize(listener) {
      process.stdout.on("resize", listener);
      return () => void process.stdout.off("resize", listener);
    },
    setRawMode(on) {
      process.stdin.setRawMode?.(on);
    },
    onProcessExit(listener) {
      const fatal = (error: unknown) => {
        listener();
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
      };
      process.on("exit", listener);
      process.on("uncaughtException", fatal);
      return () => {
        process.off("exit", listener);
        process.off("uncaughtException", fatal);
      };
    },
  };
}
