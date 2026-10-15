// Supports: SPEC-INT-022 (real background task composition and actual Windows execution-state API).
import { expect, test } from "bun:test";
import { dlopen } from "bun:ffi";
import { KeepAwake } from "../src/integrations/keep-awake";
import { acquireAwake } from "../src/platform/keep-awake";
import { Host } from "./helpers/control";
import { workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
test("SPEC-INT-022/CA-01 — the CLI retains its awake lease after the main turn while the real background process is still working", async () => {
  const ws = workspace(),
    p = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: "run_shell",
            input: {
              command: 'bun -e "setTimeout(()=>{},2000)"',
              detached: true,
            },
          },
        ],
      },
      { text: "Background ready." },
    ]);
  let acquired = 0,
    released = 0;
  const h = new Host(ws, {
    provider: p,
    env: productEnv(ws),
    userConfig: {
      integrations: { keepAwake: true },
      permissions: { allowRules: ["run_shell"] },
    },
    extra: {
      keepAwakeAcquire: async () => {
        acquired++;
        return async () => {
          released++;
        };
      },
    },
  });
  try {
    h.user("Start a long background task");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Background ready."),
    );
    const active = await h.request("get_state");
    expect(JSON.stringify(active)).toContain('"status":"running"');
    expect(acquired).toBe(1);
    expect(released).toBe(0);
    for (let i = 0; i < 80; i++) {
      const state = await h.request("get_state");
      if (!JSON.stringify(state).includes('"status":"running"')) break;
      await sleep(50);
    }
    await sleep(300);
    expect(released).toBe(1);
  } finally {
    h.feed.end();
    await h.finish();
  }
  expect(released).toBe(1);
}, 15000);
test("TECH — native Windows leases set system-required, share ownership and restore the thread state without display inhibition", async () => {
  if (process.platform !== "win32") {
    try {
      const release = await acquireAwake({ ...process.env } as Record<
        string,
        string
      >);
      await release();
    } catch (error) {
      expect((error as Error).message).toContain("unavailable");
    }
    return;
  }
  const library = dlopen("kernel32.dll", {
      SetThreadExecutionState: { args: ["u32"], returns: "u32" },
    }),
    call = library.symbols.SetThreadExecutionState;
  const before = call(0x80000000);
  call(before);
  const first = await acquireAwake({}),
    second = await acquireAwake({});
  try {
    const held = call((before | 0x80000001) >>> 0);
    expect(held & 1).toBe(1);
    expect(held & 2).toBe(before & 2);
    await first();
    const shared = call((before | 0x80000001) >>> 0);
    expect(shared & 1).toBe(1);
    await second();
    const restored = call(0x80000000);
    expect(restored).toBe(before);
    call(before);
  } finally {
    await first();
    await second();
    call(before);
    library.close();
  }
}, 10000);
test("TECH — closing joins a late acquisition and releases it exactly once", async () => {
  let open = () => {},
    releases = 0,
    closed = false;
  const pending = new Promise<void>((r) => {
      open = r;
    }),
    awake = new KeepAwake({
      enabled: () => true,
      acquire: async () => {
        await pending;
        return async () => {
          releases++;
        };
      },
    });
  awake.update(true);
  await sleep(0);
  const closing = awake.close().then(() => {
    closed = true;
  });
  await sleep(0);
  expect(closed).toBe(false);
  open();
  await closing;
  expect(releases).toBe(1);
  await awake.close();
  expect(releases).toBe(1);
});
test("TECH — disabled or unavailable inhibition remains quiet and does not retry during one activity period", async () => {
  let calls = 0;
  const disabled = new KeepAwake({
    enabled: () => false,
    acquire: async () => {
      calls++;
      throw Error("unavailable");
    },
  });
  disabled.update(true);
  await disabled.close();
  expect(calls).toBe(0);
  const absent = new KeepAwake({
    enabled: () => true,
    acquire: async () => {
      calls++;
      throw Error("unavailable");
    },
  });
  absent.update(true);
  await sleep(0);
  absent.update(true);
  await sleep(0);
  expect(calls).toBe(1);
  absent.update(false);
  absent.update(true);
  await sleep(0);
  expect(calls).toBe(2);
  await absent.close();
});
