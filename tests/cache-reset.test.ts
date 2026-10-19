import { profiledTest } from "./helpers/profiled-test";
// Supports: SPEC-CMD-084, SPEC-MOT-034.
import { expect, test } from "bun:test";
import { Host } from "./helpers/control";
import { workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { withCacheDiagnostics } from "../src/providers/cache-diagnostics";
import type { ModelProvider } from "../src/providers/types";

const internalProfileTest = profiledTest(import.meta.path, "internal");
{
const test = internalProfileTest;
test("SPEC-CMD-084/CA-01 — reset changes the first cache prefix and labels only the next request as deliberate", async () => {
  const p = new ScriptedProvider([
    { text: "first" },
    { text: "second" },
    { text: "third" },
    { text: "fourth" },
  ]);
  const cache = new Set<string>(),
    reads: number[] = [],
    diagnostics: unknown[] = [];
  const service: ModelProvider = {
    id: p.id,
    async *stream(request, signal) {
      const prefix = JSON.stringify([request.tools, request.system]);
      const read = cache.has(prefix) ? 2000 : 0;
      cache.add(prefix);
      reads.push(read);
      for await (const event of p.stream(request, signal))
        yield event.type === "message_complete"
          ? { ...event, usage: { ...event.usage, cacheReadTokens: read } }
          : event;
    },
  };
  const h = new Host(workspace(), {
    provider: withCacheDiagnostics(service, {
      maxThreads: 3,
      log: (d) => diagnostics.push(d),
    }),
    init: {},
  });
  try {
    for (const [i, command] of ["one", "two", "three", "four"].entries()) {
      if (i === 2)
        expect(
          JSON.stringify(
            await h.request("invoke_command", { command: "/cache-reset" }),
          ),
        ).toContain("prochain");
      h.user(command);
      await h.waitFor(
        (m) =>
          m.type === "turn_completed" &&
          JSON.stringify(m).includes(
            ["first", "second", "third", "fourth"][i]!,
          ),
      );
    }
    expect(reads).toEqual([0, 2000, 0, 2000]);
    expect(p.requests.map((r) => r.intentionalCacheReset ?? false)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(p.requests[2]!.tools[0]!.description).not.toBe(
      p.requests[1]!.tools[0]!.description,
    );
    expect(diagnostics).toEqual([expect.objectContaining({ expected: true })]);
    expect(JSON.stringify(p.requests[2]!.history)).toContain("first");
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
}, 20000);

}
