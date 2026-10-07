// Supports: SPEC-MOD-002 (EF-03 stdout/stderr separation, EF-06 prompt from stdin, § 5.1 terminal detection)
// Runtime adapter: standard streams, terminal detection and termination signals.

import { createInterface } from "node:readline";

export interface StandardStreams {
  writeOut(text: string): void;
  writeErr(text: string): void;
  readAllStdin(): Promise<string>;
  /** Lines of the standard input as they arrive, without their line break (SPEC-MOD-003 `jsonl` input). */
  stdinLines(): AsyncIterable<string>;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

export function processStreams(): StandardStreams {
  return {
    writeOut: (text) => void process.stdout.write(text),
    writeErr: (text) => void process.stderr.write(text),
    readAllStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return Buffer.concat(chunks).toString("utf8");
    },
    stdinLines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  };
}

/** Calls `onSignal` on the first interruption or termination request; returns an unsubscribe function. */
export function onTerminationSignal(onSignal: (signal: string) => void): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const handler = (signal: NodeJS.Signals) => onSignal(signal);
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}

/** Flushes the standard streams, then terminates the process. The only process exit point of the product. */
export async function terminate(code: number): Promise<never> {
  await Promise.all([
    new Promise<void>((r) => (process.stdout.writableNeedDrain ? process.stdout.once("drain", () => r()) : r())),
    new Promise<void>((r) => (process.stderr.writableNeedDrain ? process.stderr.once("drain", () => r()) : r())),
  ]);
  process.exit(code);
}
