// The encryption foundation is tested independently; it does not yet enable persistent encrypted sessions.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { openArchiveKeys, ArchiveFailure } from "../src/session/archive-crypto";
import { ArchiveFiles } from "../src/session/archive-files";
import { VaultUnavailable, type CredentialVault } from "../src/platform/credential-vault";
import { workspace } from "./helpers/env";

class Vault implements CredentialVault {
  readonly entries = new Map<string, string>();
  read(service: string, account: string) { return this.entries.get(service + "/" + account); }
  write(service: string, account: string, value: string) { this.entries.set(service + "/" + account, value); }
  remove(service: string, account: string) { this.entries.delete(service + "/" + account); }
}
async function fixture() {
  const ws = workspace(), vault = new Vault();
  const keys = await openArchiveKeys({ service: "fixture-archives", configDir: ws.configHome, vault });
  return { ws, vault, keys, cipher: keys.cipher() };
}

test("TECH — authenticated archive frames conceal bytes, bind their domain and reject a completed alteration", async () => {
  const { cipher } = await fixture();
  const witness = Buffer.from("private fixture content 4189");
  const bytes = cipher.encode("transcript/session", [witness]);
  expect(bytes.toString()).not.toContain(witness.toString());
  expect(cipher.decode("transcript/session", bytes).chunks).toEqual([witness]);
  expect(() => cipher.decode("transcript/other", bytes)).toThrow(ArchiveFailure);
  const lines = bytes.toString().split("\n");
  const parts = lines[2]!.split(".");
  const body = Buffer.from(parts[2]!, "base64"); body[0] = body[0]! ^ 1;
  parts[2] = body.toString("base64"); lines[2] = parts.join(".");
  expect(() => cipher.decode("transcript/session", Buffer.from(lines.join("\n")))).toThrow("altérées");
});

test("TECH — only an incomplete final frame can be ignored, and all complete frames are authenticated first", async () => {
  const { cipher } = await fixture();
  const bytes = cipher.encode("log", [Buffer.from("first"), Buffer.from("second")]);
  const partial = bytes.subarray(0, bytes.length - 9);
  expect(cipher.decode("log", partial, true)).toMatchObject({ chunks: [Buffer.from("first")], partial: true });
  expect(() => cipher.decode("log", partial)).toThrow(ArchiveFailure);
  const reordered = bytes.toString().split("\n");
  [reordered[2], reordered[3]] = [reordered[3]!, reordered[2]!];
  expect(() => cipher.decode("log", Buffer.from(reordered.join("\n")), true)).toThrow(ArchiveFailure);
  expect(() => cipher.decode("log", Buffer.from("archive:1:bad\n"), true)).toThrow(ArchiveFailure);
});

test("TECH — profile and distribution isolate vault keys, and neither an absent key nor a locked vault creates a fallback", async () => {
  const { ws, vault, cipher } = await fixture();
  const reopen = await openArchiveKeys({ service: "fixture-archives", configDir: ws.configHome, vault, requireExisting: true });
  const bytes = cipher.encode("blob", [Buffer.from("secret")]);
  expect(reopen.cipher().decode("blob", bytes).chunks[0]!.toString()).toBe("secret");
  const other = join(ws.home, "other"); mkdirSync(other);
  await expect(openArchiveKeys({ service: "fixture-archives", configDir: other, vault, requireExisting: true })).rejects.toThrow(ArchiveFailure);
  await expect(openArchiveKeys({ service: "other-distribution", configDir: ws.configHome, vault, requireExisting: true })).rejects.toThrow(ArchiveFailure);
  const locked: CredentialVault = { read() { throw new VaultUnavailable(true); }, write() { throw new Error("must not write"); }, remove() {} };
  await expect(openArchiveKeys({ service: "fixture-archives", configDir: ws.configHome, vault: locked })).rejects.toThrow("coffre");
});

test("TECH — disk migration verifies before replacement, append repairs an interrupted tail, rotation resumes with both keys", async () => {
  const { ws, vault, keys, cipher } = await fixture();
  const file = join(ws.configHome, "session.jsonl"), files = new ArchiveFiles(ws.configHome, cipher);
  writeFileSync(file, "private first\n");
  const originalFingerprint = files.contentFingerprint(file, Buffer.from("private first\n"));
  files.importPlaintext(file, originalFingerprint);
  files.importPlaintext(file, originalFingerprint);
  expect(files.read(file).toString()).toBe("private first\n");
  expect(readFileSync(file).toString()).not.toContain("private first");
  files.append(file, Buffer.from("private second\n"));
  const complete = readFileSync(file);
  writeFileSync(file, Buffer.concat([complete, Buffer.from("incomplete-frame")]));
  expect(files.read(file, true).toString()).toBe("private first\nprivate second\n");
  files.append(file, Buffer.from("third\n"));
  expect(files.read(file, true).toString()).toBe("private first\nprivate second\nthird\n");
  const name = cipher.fingerprint("history", Buffer.from("content"));
  await expect(keys.rotate(async (next) => {
    const rotating = new ArchiveFiles(ws.configHome, next);
    rotating.migrate(file, true); rotating.verifyActive(file, true);
    throw new Error("simulated interruption");
  })).rejects.toThrow("simulated interruption");
  expect(Object.keys(keys.ring.keys)).toHaveLength(2);
  const restarted = await openArchiveKeys({ service: "fixture-archives", configDir: ws.configHome, vault, requireExisting: true });
  await restarted.rotate(async (next) => {
    expect(next.fingerprint("history", Buffer.from("content"))).toBe(name);
    const rotating = new ArchiveFiles(ws.configHome, next);
    expect(rotating.read(file, true).toString()).toContain("third");
    rotating.migrate(file, true); rotating.verifyActive(file, true);
  });
  expect(Object.keys(restarted.ring.keys)).toHaveLength(1);
  expect(new ArchiveFiles(ws.configHome, restarted.cipher()).read(file, true).toString()).toContain("private second");
});

test("TECH — store paths cannot escape, linked plaintext is not removed by migration, and damaged ciphertext never becomes plaintext", async () => {
  const { ws, cipher } = await fixture(), files = new ArchiveFiles(ws.configHome, cipher);
  expect(() => files.write(join(ws.project, "outside"), Buffer.from("private"))).toThrow(ArchiveFailure);
  const file = join(ws.configHome, "linked"); writeFileSync(file, "private");
  linkSync(file, join(ws.project, "alias"));
  expect(() => files.importPlaintext(file, "invalid")).toThrow(ArchiveFailure);
  expect(readFileSync(file).toString()).toBe("private");
  const broken = join(ws.configHome, "broken"); files.write(broken, Buffer.from("private"));
  const bytes = readFileSync(broken), last = bytes.lastIndexOf(46); bytes[last + 1] = 33; writeFileSync(broken, bytes);
  expect(() => files.migrate(broken)).toThrow(ArchiveFailure);
  expect(readFileSync(broken)).toEqual(bytes);
  const damagedHeader = join(ws.configHome, "damaged-header"); files.write(damagedHeader, Buffer.from("private"));
  const damaged = readFileSync(damagedHeader); damaged[0] = 33; writeFileSync(damagedHeader, damaged);
  expect(() => files.migrate(damagedHeader)).toThrow(ArchiveFailure);
  expect(readFileSync(damagedHeader)).toEqual(damaged);
  cipher.destroy(); expect(() => files.read(broken)).toThrow("terminé");
});

test("TECH — completed last frame without LF is authenticated and its separator is restored before append", async () => {
  const { ws, cipher } = await fixture(), files = new ArchiveFiles(ws.configHome, cipher), file = join(ws.configHome, "no-lf");
  const empty = cipher.encode("empty", []);
  expect(cipher.decode("empty", empty.subarray(0, -1), true)).toMatchObject({ chunks: [], needsNewline: true });
  files.append(file, Buffer.from("first"));
  writeFileSync(file, readFileSync(file).subarray(0, -1));
  expect(files.read(file, true).toString()).toBe("first");
  files.append(file, Buffer.from("second"));
  expect(files.read(file, true).toString()).toBe("firstsecond");
  const lines = readFileSync(file).toString().trimEnd().split("\n"), parts = lines[lines.length - 1]!.split(".");
  const body = Buffer.from(parts[2]!, "base64"); body[0] = body[0]! ^ 1; parts[2] = body.toString("base64");
  lines[lines.length - 1] = parts.join("."); writeFileSync(file, lines.join("\n"));
  expect(() => files.read(file, true)).toThrow("altérées");
  expect(() => files.append(file, Buffer.from("third"))).toThrow("altérées");
});

test("TECH — rotation revokes ciphers from independent opens and mutations refuse an occupied key lock", async () => {
  const { ws, vault, keys, cipher } = await fixture();
  const independentlyOpened = await openArchiveKeys({ service: "fixture-archives", configDir: ws.configHome, vault });
  const stale = independentlyOpened.cipher(), file = join(ws.configHome, "future");
  const files = new ArchiveFiles(ws.configHome, cipher);
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), barrier = new Promise<void>((resolve) => { finish = resolve; });
  const rotation = keys.rotate(async () => { enter(); await barrier; });
  await entered;
  try { expect(() => files.write(file, Buffer.from("blocked"))).toThrow("suspendue"); } finally { finish(); }
  await rotation;
  expect(() => new ArchiveFiles(ws.configHome, stale).append(file, Buffer.from("obsolete"))).toThrow("renouvelée");
  const current = new ArchiveFiles(ws.configHome, keys.cipher()); current.append(file, Buffer.from("current"));
  expect(current.read(file, true).toString()).toBe("current");
});

test("TECH — candidate names cannot overwrite another store and distribution generations remain independent", async () => {
  const { ws, vault, cipher } = await fixture(), files = new ArchiveFiles(ws.configHome, cipher);
  const neighbour = join(ws.configHome, "one.archive-tmp"); files.write(neighbour, Buffer.from("neighbour"));
  files.write(join(ws.configHome, "one"), Buffer.from("one"));
  expect(files.read(neighbour).toString()).toBe("neighbour");
  const other = await openArchiveKeys({ service: "another-distribution", configDir: ws.configHome, vault });
  expect(other.cipher().fingerprint("fixture", Buffer.from("x"))).not.toBe(cipher.fingerprint("fixture", Buffer.from("x")));
  expect(files.read(neighbour).toString()).toBe("neighbour");
});
