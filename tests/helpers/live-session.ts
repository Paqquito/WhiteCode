// Native idle session used for presence and process-lifetime proofs; no model request is sent.
import { join } from "node:path";
import { loadIdentity, ROOT, type Workspace } from "./env";
import { productEnv } from "./hooks";
export async function liveSession(ws: Workspace, id: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(ROOT, "src/main.ts"),
      "--non-interactive",
      "--control-channel",
      "--request-format=jsonl",
      "--result-format=jsonl",
      "--reopen=" + id,
    ],
    {
      cwd: ws.project,
      env: productEnv(ws, {
        [loadIdentity().get("ENV_PREFIX") + "CONFIG_HOME"]: ws.configHome,
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  let partial = "";
  const output = (async () => {
    for await (const chunk of child.stdout) {
      partial += Buffer.from(chunk).toString();
      for (let end; (end = partial.indexOf("\n")) !== -1;) {
        const line = partial.slice(0, end);
        partial = partial.slice(end + 1);
        try {
          if (JSON.parse(line).type === "session") ready();
        } catch {}
      }
    }
  })();
  child.stdin.write(
    JSON.stringify({
      type: "control_init",
      protocolVersion: "1.0",
      demands: [],
    }) + "\n",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      child.exited.then(async () => {
        throw Error("Idle session exited: " + (await stderr));
      }),
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Idle session startup deadline")),
          10000,
        );
      }),
    ]);
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    pid: child.pid,
    close: async () => {
      child.stdin.end();
      const stop = setTimeout(() => child.kill(), 5000);
      try {
        await child.exited;
        await output;
        await stderr;
      } finally {
        clearTimeout(stop);
      }
    },
  };
}
