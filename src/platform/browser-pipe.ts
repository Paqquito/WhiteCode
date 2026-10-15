// Supports: SPEC-OUT-014 (isolated Chromium process, private debugging pipe, owned lifetime), gap E-209.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export function browserExecutable(
  env: Readonly<Record<string, string>> = {},
): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          join(
            env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
            "Microsoft/Edge/Application/msedge.exe",
          ),
          join(
            env["ProgramFiles"] ?? "C:/Program Files",
            "Google/Chrome/Application/chrome.exe",
          ),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["chromium", "chromium-browser", "google-chrome", "microsoft-edge"]
            .map((name) => Bun.which(name, { PATH: env["PATH"] ?? "" }))
            .filter((path): path is string => !!path);
  return candidates.find((path) => existsSync(path));
}
export interface BrowserPipe {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, any>>;
  close(): Promise<void>;
}
/** CDP is never exposed on a local TCP port or attached to a personal profile. */
export function openBrowserPipe(options: {
  executable: string;
  headless?: boolean;
  env: Readonly<Record<string, string>>;
  event: (
    method: string,
    params: Record<string, any>,
    session?: string,
  ) => void;
}): BrowserPipe {
  const profile = mkdtempSync(join(tmpdir(), "isolated-browser-"));
  const child = spawn(
    options.executable,
    [
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "--disable-background-networking",
      ...(options.headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    {
      env: options.env,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  const input = child.stdio[3] as Writable,
    output = child.stdio[4] as Readable;
  const pending = new Map<
    number,
    {
      resolve: (v: Record<string, any>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let serial = 0,
    buffer = Buffer.alloc(0),
    closed = false,
    closing: Promise<void> | undefined;
  const fail = () => {
    closed = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("Isolated browser closed."));
    }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  input.on("error", fail);
  output.on("error", fail);
  output.on("data", (part: Buffer) => {
    buffer = Buffer.concat([buffer, part]);
    if (buffer.length > 8 * 1024 * 1024) {
      void api.close();
      return;
    }
    for (;;) {
      const end = buffer.indexOf(0);
      if (end < 0) break;
      const frame = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      try {
        const message = JSON.parse(frame);
        if (typeof message.id === "number") {
          const p = pending.get(message.id);
          if (!p) continue;
          pending.delete(message.id);
          clearTimeout(p.timer);
          message.error
            ? p.reject(Error(String(message.error.message).slice(0, 500)))
            : p.resolve(message.result ?? {});
        } else if (typeof message.method === "string")
          options.event(
            message.method,
            message.params ?? {},
            message.sessionId,
          );
      } catch {
        /* Malformed events convey no authority. */
      }
    }
  });
  const api: BrowserPipe = {
    send(method, params = {}, sessionId) {
      if (closed || closing)
        return Promise.reject(Error("Isolated browser closed."));
      if (pending.size >= 512) {
        void api.close();
        return Promise.reject(Error("Browser request limit exceeded."));
      }
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Browser operation timed out."));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        input.write(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }) + "\0",
        );
      });
    },
    close() {
      return (closing ??= (async () => {
        fail();
        input.end();
        if (child.pid && child.exitCode === null) {
          if (process.platform === "win32")
            spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
          else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
          await Promise.race([
            new Promise<void>((resolve) =>
              child.once("close", () => resolve()),
            ),
            new Promise<void>((resolve) => setTimeout(resolve, 1500)),
          ]);
        }
        output.destroy();
        input.destroy();
        // This path is the exact directory returned by mkdtemp, never supplied by a caller.
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {
          /* A closing OS handle may retain an empty isolated profile. */
        }
      })());
    },
  };
  return api;
}
