// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { OutputFiles } from "../src/session/output-files";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { systemInfo } from "../src/platform/system";
import { spawnSync } from "node:child_process";
function fixture() {
  const root = mkdtempSync(join(systemInfo().tmp, "output-files-")),
    directory = join(root, "outputs");
  mkdirSync(directory);
  spawnSync("git", ["init", "-q"], { cwd: root });
  const sent: any[] = [],
    events: any[] = [],
    store = new OutputFiles({
      root,
      directory,
      maxSize: 1024,
      maxCount: 10,
      excluded: [],
      ignored: async (paths) => {
        const result = spawnSync(
          "git",
          ["check-ignore", "--no-index", "--stdin", "-z"],
          {
            cwd: root,
            input: Buffer.from(
              paths.map((path) => path.split("\\").join("/")).join("\0") + "\0",
            ),
          },
        );
        if (![0, 1].includes(result.status ?? -1)) throw Error("git");
        return new Set(result.stdout.toString().split("\0").filter(Boolean));
      },
      upload: async (input) => {
        sent.push(input);
        return { id: "file-" + sent.length };
      },
      event: (body) => events.push(body),
    });
  return { root, directory, sent, events, store };
}
test("SPEC-SES-013/CA-01 — two files produced in the turn are uploaded and enumerated in its output event", async () => {
  const f = fixture(),
    start = Date.now() - 100;
  writeFileSync(join(f.directory, "a.txt"), "first");
  writeFileSync(join(f.directory, "b.txt"), "second");
  await f.store.capture(start, new AbortController().signal);
  expect(
    f.sent.map((s) => Buffer.from(s.data, "base64").toString()).sort(),
  ).toEqual(["first", "second"]);
  expect(f.events[0].files.map((v: any) => v.id)).toEqual(["file-1", "file-2"]);
});
test("SPEC-SES-013/CA-02 — a modified Git-ignored file is excluded from all uploads", async () => {
  const f = fixture();
  writeFileSync(join(f.root, ".gitignore"), "outputs/private.txt\n");
  writeFileSync(join(f.directory, "private.txt"), "do not upload");
  writeFileSync(join(f.directory, "public.txt"), "deliverable");
  await f.store.capture(Date.now() - 100, new AbortController().signal);
  expect(f.sent.map((s) => s.path)).toEqual(["outputs/public.txt"]);
  expect(JSON.stringify(f.sent)).not.toContain("do not upload");
});
test("TECH — unchanged files, oversized files and dependency trees are excluded before reading contents", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, "old.txt"), "old");
  utimesSync(join(f.directory, "old.txt"), new Date(0), new Date(0));
  writeFileSync(join(f.directory, "large.txt"), "x".repeat(2048));
  mkdirSync(join(f.directory, "node_modules"));
  writeFileSync(join(f.directory, "node_modules", "dep.txt"), "dependency");
  await f.store.capture(Date.now() - 100, new AbortController().signal);
  expect(f.sent).toHaveLength(0);
});
