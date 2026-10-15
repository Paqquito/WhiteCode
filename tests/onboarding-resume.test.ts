// Supports: SPEC-IHM-026/CA-01 (real native welcome resumes from its durable checkpoint).
import { expect, test } from "bun:test";
import { join, basename } from "node:path";
import { readUserState } from "../src/config/user-state";
import { workspace, loadIdentity } from "./helpers/env";
import { interactive, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-IHM-026/CA-01 — after interruption following theme selection the next actual startup begins at connection", async () => {
  const ws = workspace(),
    extra = {
      onboarding: true,
      credentialVault: {
        read: () => undefined,
        write: () => {},
        remove: () => {},
      },
    },
    userConfig = { api: { provider: "openai" } };
  const firstController = new AbortController(),
    first = interactive([], ws, {
      provider: new ScriptedProvider([]),
      signal: firstController.signal,
      extra,
      userConfig,
      columns: 160,
      rows: 35,
    });
  try {
    await first.waitFor((text) => text.includes("Accueil 1/5 — Thème"));
    await sleep(400);
    first.type("o");
    await first.waitFor((text) => text.includes("Accueil 2/5 — Connexion"));
    expect(
      readUserState(
        join(ws.configHome, basename(loadIdentity().get("USER_STATE_FILE"))),
      ).onboardingStep,
    ).toBe("connection");
  } finally {
    firstController.abort();
    await first.done;
  }
  const nextController = new AbortController(),
    next = interactive([], ws, {
      provider: new ScriptedProvider([]),
      signal: nextController.signal,
      extra,
      userConfig,
      columns: 160,
      rows: 35,
    });
  try {
    await next.waitFor((text) => text.includes("Accueil 2/5 — Connexion"));
    expect(next.all().join("\n")).not.toContain("Accueil 1/5 — Thème");
  } finally {
    nextController.abort();
    await next.done;
  }
}, 10000);
