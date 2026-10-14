import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processExists, startChild } from "../src/platform/process";

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Process-tree fixture did not settle.");
    await Bun.sleep(10);
  }
}

test.skipIf(process.platform !== "win32")("TECH — killTree stops native Windows descendants even when the POSIX stop callback already killed their leader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "process-tree-lifetime47-")), pids = join(dir, "pids.json"), descendant = join(dir, "descendant.ts"), leader = join(dir, "leader.ts");
  writeFileSync(descendant, "await Bun.sleep(30_000);\n");
  writeFileSync(leader, `const child = Bun.spawn([process.execPath, ${JSON.stringify(descendant)}], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });\nconst { writeFileSync } = await import("node:fs");\nwriteFileSync(${JSON.stringify(pids)}, JSON.stringify({ parent: process.pid, child: child.pid }));\nawait Bun.sleep(30_000);\n`);
  let descendantPid: number | undefined;
  const parent = startChild(process.execPath, [leader], {
    cwd: dir, env: { ...process.env } as Record<string, string>, onData: () => {},
    stopDescendants: () => {
      process.kill(parent.pid!);
      // Let the native leader disappear before taskkill tries to rediscover its tree.
      Bun.sleepSync(100);
    },
  });
  try {
    await waitUntil(() => existsSync(pids) && readFileSync(pids, "utf8").endsWith("}"));
    const recorded = JSON.parse(readFileSync(pids, "utf8")) as { parent: number; child: number };
    descendantPid = recorded.child;
    expect(recorded.parent).toBe(parent.pid!);
    expect({ parent: processExists(parent.pid!), child: processExists(descendantPid) }).toEqual({ parent: true, child: true });
    await parent.killTree(50);
    expect({ parent: processExists(parent.pid!), child: processExists(descendantPid) }).toEqual({ parent: false, child: false });
  } finally {
    if (descendantPid === undefined && existsSync(pids)) descendantPid = (JSON.parse(readFileSync(pids, "utf8")) as { child: number }).child;
    for (const pid of [descendantPid, parent.pid]) if (pid !== undefined && processExists(pid)) process.kill(pid);
    await parent.exited;
    await waitUntil(() => [descendantPid, parent.pid].every(pid => pid === undefined || !processExists(pid)));
  }
}, 10_000);
