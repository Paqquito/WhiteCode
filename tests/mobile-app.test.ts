// Supports: SPEC-CMD-044.
import { expect, test } from "bun:test";
import { Host } from "./helpers/control";
import { workspace, loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Identity } from "../src/identity/identity";
test("SPEC-CMD-044/CA-01 — switching the mobile platform changes both the link and the QR target", async () => {
  const base = loadIdentity(),
    identity = new Identity({
      ...base.resolved,
      values: {
        ...base.resolved.values,
        SERVICE_MOBILE_IOS: {
          value: "https://apps.example.test/ios",
          origin: "provided",
        },
        SERVICE_MOBILE_ANDROID: {
          value: "https://apps.example.test/android",
          origin: "provided",
        },
      },
    });
  const h = new Host(workspace(), {
    identity,
    provider: new ScriptedProvider([]),
    init: {},
  });
  try {
    const ios = await h.request("invoke_command", {
        command: "/mobile-app ios",
      }),
      android = await h.request("invoke_command", {
        command: "/mobile-app android",
      });
    const a = JSON.stringify(ios.result),
      b = JSON.stringify(android.result);
    expect(a).toContain("https://apps.example.test/ios");
    expect(b).toContain("https://apps.example.test/android");
    expect(a).not.toEqual(b);
    expect(
      (ios.result as { shown: string }).shown
        .split("\n")
        .every((line) => [...line].length <= 80),
    ).toBe(true);
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
});
