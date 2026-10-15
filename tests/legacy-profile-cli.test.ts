// Supports: SPEC-CAD-002/CA-16 (actual startup before creating the destination profile).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { Identity } from "../src/identity/identity";
import { workspace, loadIdentity, TEST_USER_CONFIG } from "./helpers/env";
import { interactive, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("TECH — real interactive startup proposes the declared previous profile before creating the new one and preserves the old data", async () => {
  const ws = workspace(),
    old = join(ws.root, "previous-profile"),
    destination = join(ws.home, "next-profile"),
    original = loadIdentity();
  ws.write("previous-profile/config.json", JSON.stringify(TEST_USER_CONFIG));
  ws.write("previous-profile/memory/witness.txt", "Previous profile receipt");
  const identity = new Identity({
    ...original.resolved,
    compatibility: {
      ...original.resolved.compatibility,
      allowLegacyReads: true,
      previousConfigDirs: [old],
    },
  });
  const controller = new AbortController(),
    run = interactive([], ws, {
      identity,
      env: { [identity.get("ENV_PREFIX") + "CONFIG_HOME"]: destination },
      signal: controller.signal,
      provider: new ScriptedProvider([]),
    });
  try {
    await run.waitFor((text) => text.includes("Ancien profil déclaré"));
    expect(existsSync(destination)).toBe(false);
    await sleep(400);
    run.type("o");
    await run.idle();
    expect(readFileSync(join(destination, "memory/witness.txt"), "utf8")).toBe(
      "Previous profile receipt",
    );
    expect(readFileSync(join(old, "memory/witness.txt"), "utf8")).toBe(
      "Previous profile receipt",
    );
  } finally {
    controller.abort();
    await run.done;
  }
}, 10000);
