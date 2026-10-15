// Supports: SPEC-MOD-021/022 and SPEC-PER-001 (local controller, no model service).
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ResidentWorker, type WorkerRecord } from "../src/services/worker";
import { workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { processExists } from "../src/platform/process";
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw Error("Worker state deadline");
    await new Promise((r) => setTimeout(r, 10));
  }
};
function fixture(mode: "ask" | "no_prompt" = "ask", waitMs = 1000) {
  const ws = workspace(),
    file = join(ws.root, "effect"),
    script = ws.write(
      "worker.ts",
      `import{writeFileSync}from"node:fs";console.log(JSON.stringify({type:"session"}));for await(const line of console){const value=JSON.parse(line);if(value.type==="user")console.log(JSON.stringify({type:"control_request",id:"e-1",request:"approval_request",params:{summary:"Write fixture",input:{path:${JSON.stringify(file)}}}}));if(value.type==="control_response"){if(value.result.decision==="allow")writeFileSync(${JSON.stringify(file)},"approved");console.log(JSON.stringify({type:"turn_completed"}));}}`,
    );
  const record: WorkerRecord = {
    id: crypto.randomUUID(),
    kind: "background",
    cwd: ws.project,
    createdAt: Date.now(),
    mode,
    status: "starting",
    summary: "fixture",
    restarts: 0,
    pending: [],
  };
  let publications = 0;
  const worker = new ResidentWorker(record, {
    command: () => ({ file: process.execPath, args: [script] }),
    environment: () => productEnv(ws),
    persist: () => {
      publications++;
    },
    assertPolicy: () => {},
    waitMs,
    completed: () => {},
    error: () => {},
    wasAccepted: () => false,
  });
  return { worker, record, file, publications: () => publications };
}
test("TECH — a detached controller keeps ask suspended until a matching human answer", async () => {
  const f = fixture();
  try {
    f.worker.launch();
    f.worker.enqueue("work");
    await until(() => f.record.status === "waiting");
    expect(existsSync(f.file)).toBe(false);
    const request = f.worker.approvals[0]!;
    expect(f.worker.answer("stale:" + request.id, true)).toBe(false);
    expect(f.worker.answer(request.id, true)).toBe(true);
    await until(() => f.record.status === "completed");
    expect(existsSync(f.file)).toBe(true);
  } finally {
    await f.worker.close();
  }
});
test("TECH — an unanswered detached request is denied when its deadline expires", async () => {
  const f = fixture("ask", 50);
  try {
    f.worker.launch();
    f.worker.enqueue("work");
    await until(() => f.record.status === "completed");
    expect(existsSync(f.file)).toBe(false);
    expect(f.worker.approvals).toHaveLength(0);
  } finally {
    await f.worker.close();
  }
});
test("TECH — no_prompt never waits for a future attachment", async () => {
  const f = fixture("no_prompt", 60000);
  try {
    f.worker.launch();
    f.worker.enqueue("work");
    await until(() => f.record.status === "completed");
    expect(existsSync(f.file)).toBe(false);
  } finally {
    await f.worker.close();
  }
});
test("TECH — a registry write failure during stop cannot leave the native worker alive", async () => {
  const f = fixture();
  let pid: number | undefined;
  try {
    f.worker.launch();
    await until(() => f.record.status === "idle");
    pid = f.worker.pid;
    expect(pid).toBeGreaterThan(0);
    f.worker.options.persist = () => {
      throw Error("fixture storage failure");
    };
    await f.worker.close().catch(() => {});
    expect(processExists(pid!)).toBe(false);
  } finally {
    if (pid && processExists(pid)) process.kill(pid);
  }
});
