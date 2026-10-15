// Native process killed by the crash-recovery test; the vault below is an isolated TEST ONLY stand-in.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { openArchiveKeys } from "../../src/session/archive-crypto";
import { ArchiveFiles } from "../../src/session/archive-files";
const [root, vaultPath, mode] = process.argv.slice(2) as [
  string,
  string,
  string,
];
export function fixtureVault(path: string) {
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
const keys = await openArchiveKeys({
    service: "crash-fixture",
    configDir: root,
    vault: fixtureVault(vaultPath),
    requireExisting: true,
  }),
  cipher = keys.cipher(),
  files = new ArchiveFiles(root, cipher),
  one = join(root, "one.jsonl"),
  two = join(root, "two.jsonl");
const barrier = async () => {
  console.log("CRASH_BARRIER_REACHED");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
};
if (mode === "append") {
  const domain = relative(root, one).replaceAll("\\", "/"),
    state = cipher.decode(domain, readFileSync(one), true),
    frame = cipher.frame(
      domain,
      state.fileId,
      state.chunks.length + 1,
      Buffer.from("incomplete second record\n"),
    );
  // A real incomplete encrypted write, then termination before the remaining bytes reach the file.
  appendFileSync(one, frame.subarray(0, Math.floor(frame.length / 2)));
  await barrier();
} else if (mode === "migration") {
  files.importPlaintext(
    one,
    files.contentFingerprint(one, Buffer.from("first private record\n")),
  );
  await barrier();
} else if (mode === "rotation")
  await keys.rotate(async (next) => {
    const rotating = new ArchiveFiles(root, next);
    rotating.migrate(one, true);
    rotating.verifyActive(one, true);
    await barrier();
  });
else throw Error("Invalid crash phase");
