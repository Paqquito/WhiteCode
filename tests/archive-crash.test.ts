import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { workspace, ROOT } from "./helpers/env";
import { productEnv, BUN } from "./helpers/hooks";
import { startChild } from "../src/platform/process";
import { openArchiveKeys } from "../src/session/archive-crypto";
import { ArchiveFiles } from "../src/session/archive-files";
function fixtureVault(path: string) {
  return {
    read: (_s: string, a: string) => {
      const values = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8"))
        : {};
      return values[a] as string | undefined;
    },
    write: (_s: string, a: string, v: string) => {
      const values = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8"))
        : {};
      values[a] = v;
      writeFileSync(path, JSON.stringify(values));
    },
    remove: () => {
      throw Error("unused");
    },
  };
}
async function crash(
  mode: string,
  ws: ReturnType<typeof workspace>,
  vaultPath: string,
) {
  let output = "",
    ready!: () => void;
  const barrier = new Promise<void>((r) => (ready = r)),
    child = startChild(
      BUN,
      [
        join(ROOT, "tests/fixtures/archive-crash-worker.ts"),
        ws.configHome,
        vaultPath,
        mode,
      ],
      {
        cwd: ws.project,
        env: productEnv(ws),
        onData: (chunk) => {
          output += chunk.toString();
          if (output.includes("CRASH_BARRIER_REACHED")) ready();
        },
      },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier,
      child.exited.then((code) => {
        throw Error("Worker exited before crash: " + code + " " + output);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Crash barrier unavailable: " + output)),
          10000,
        );
      }),
    ]);
    await child.killTree(0);
    await child.exited;
  } finally {
    if (timer) clearTimeout(timer);
    await child.killTree(0);
  }
}
test("SPEC-SES-001/CA-08 — native process termination during append, migration and two-key rotation resumes without replacing encrypted data by plaintext", async () => {
  for (const mode of ["append", "migration", "rotation"]) {
    const ws = workspace(),
      vaultPath = join(ws.root, "TEST-ONLY-vault.json"),
      vault = fixtureVault(vaultPath),
      keyOptions = {
        service: "crash-fixture",
        configDir: ws.configHome,
        vault,
      },
      keys = await openArchiveKeys(keyOptions),
      files = new ArchiveFiles(ws.configHome, keys.cipher()),
      one = join(ws.configHome, "one.jsonl"),
      two = join(ws.configHome, "two.jsonl");
    if (mode === "migration") {
      writeFileSync(one, "first private record\n");
      writeFileSync(two, "second private record\n");
    } else {
      files.append(one, Buffer.from("first private record\n"));
      files.append(two, Buffer.from("second private record\n"));
    }
    await crash(mode, ws, vaultPath);
    expect(readFileSync(one).toString()).not.toContain("first private record");
    const restarted = await openArchiveKeys({
      ...keyOptions,
      requireExisting: true,
    });
    if (mode === "rotation") {
      expect(Object.keys(restarted.ring.keys)).toHaveLength(2);
      await restarted.rotate(async (cipher) => {
        const resumed = new ArchiveFiles(ws.configHome, cipher);
        for (const path of [one, two]) {
          resumed.migrate(path, true);
          resumed.verifyActive(path, true);
        }
      });
      expect(Object.keys(restarted.ring.keys)).toHaveLength(1);
    }
    const resumed = new ArchiveFiles(ws.configHome, restarted.cipher());
    if (mode === "migration")
      for (const [path, value] of [
        [one, "first private record\n"],
        [two, "second private record\n"],
      ] as const)
        resumed.importPlaintext(
          path,
          resumed.contentFingerprint(path, Buffer.from(value)),
        );
    expect(resumed.read(one, true).toString()).toBe("first private record\n");
    expect(resumed.read(two, true).toString()).toBe("second private record\n");
    resumed.append(one, Buffer.from("next record after restart\n"));
    expect(resumed.read(one, true).toString()).toBe(
      "first private record\nnext record after restart\n",
    );
    for (const path of [one, two])
      expect(readFileSync(path).toString()).not.toContain("private record");
  }
}, 40000);
