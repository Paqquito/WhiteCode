// Supports: SPEC-MOD-021/022 (local authenticated service).
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  ResidentSupervisor,
  readResidentEndpoint,
} from "../src/services/supervisor";
import { residentFetch } from "../src/platform/resident-process";
import { workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";

test("SPEC-MOD-026/CA-02 — completion of a real unattended assistant worker reaches the notification channel", async () => {
  const ws = workspace(),
    script = ws.write(
      "complete.ts",
      'console.log(JSON.stringify({type:"session"}));for await(const line of console){const m=JSON.parse(line);if(m.type==="user")console.log(JSON.stringify({type:"turn_completed"}));}',
    );
  const notifications: Array<{ id: string; kind: string }> = [];
  const service = new ResidentSupervisor({
    root: ws.configHome,
    maxConcurrent: 4,
    waitMs: 1000,
    assertPolicy: () => {},
    program: () => ({ file: process.execPath, args: [script] }),
    environment: () => productEnv(ws),
    wasAccepted: () => false,
    history: () => [],
    notify: async (record, kind) => {
      notifications.push({ id: record.id, kind });
    },
  });
  try {
    await service.start();
    const endpoint = readResidentEndpoint(ws.configHome)!,
      made = await residentFetch(
        endpoint.port,
        endpoint.token,
        "/workers",
        {
          kind: "assistant",
          cwd: ws.project,
          prompt: "Complete the important task.",
        },
        AbortSignal.timeout(3000),
      ),
      worker = (await made.json()) as { id: string };
    const end = Date.now() + 5000;
    while (!notifications.length && Date.now() < end)
      await new Promise((r) => setTimeout(r, 30));
    expect(notifications).toEqual([{ id: worker.id, kind: "completed" }]);
  } finally {
    await service.close();
  }
});
test("TECH — the resident API rejects missing capabilities and browser origins and lists a real worker", async () => {
  const ws = workspace(),
    script = ws.write(
      "idle.ts",
      'console.log(JSON.stringify({type:"session"}));for await(const _ of console) {}',
    );
  const service = new ResidentSupervisor({
    root: ws.configHome,
    maxConcurrent: 4,
    waitMs: 1000,
    assertPolicy: () => {},
    program: () => ({ file: process.execPath, args: [script] }),
    environment: () => productEnv(ws),
    wasAccepted: () => false,
    history: () => [],
    notify: async () => {},
  });
  try {
    await service.start();
    const endpoint = readResidentEndpoint(ws.configHome)!;
    expect(endpoint.port).toBeGreaterThan(0);
    const bad = await residentFetch(
      endpoint.port,
      "wrong",
      "/state",
      undefined,
      AbortSignal.timeout(1000),
    );
    expect(bad.status).toBe(401);
    const origin = await fetch(`http://127.0.0.1:${endpoint.port}/state`, {
      headers: {
        authorization: "Bearer " + endpoint.token,
        origin: "https://example.test",
      },
    });
    expect(origin.status).toBe(403);
    const made = await residentFetch(
      endpoint.port,
      endpoint.token,
      "/workers",
      { kind: "assistant", cwd: ws.project },
      AbortSignal.timeout(3000),
    );
    expect(made.status).toBe(200);
    const state = await residentFetch(
      endpoint.port,
      endpoint.token,
      "/state",
      undefined,
      AbortSignal.timeout(1000),
    );
    const body = (await state.json()) as { workers: Array<{ pid?: number }> };
    expect(body.workers).toHaveLength(1);
    expect(body.workers[0]!.pid).toBeGreaterThan(0);
  } finally {
    await service.close();
  }
});
