import { expect, test, spyOn } from "bun:test";
import { ArchiveFiles } from "../src/session/archive-files";
import { join } from "node:path";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  lstatSync,
  cpSync,
  unlinkSync,
} from "node:fs";
import { workspace } from "./helpers/env";
import { cli } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { AgentMemory } from "../src/agents/agent-memory";
import { Teams } from "../src/agents/teams";
import { SessionNotes } from "../src/memory/session-notes";
import { ResultStore } from "../src/session/result-store";
import { readFileTool } from "../src/tools/read-file";
import { archiveAccessTool } from "../src/tools/archive-access";
import { testToolFields } from "./helpers/env";
import { currentPlatform } from "../src/platform/system";
import { BackgroundTasks } from "../src/engine/background";
import { Asciicast } from "../src/observability/asciicast";
import {
  TranscriptAccess,
  readTranscriptReference,
} from "../src/session/transcript-access";
import { writeAtomic } from "../src/tools/text-file";
import { InputHistory } from "../src/interactive/history";
import {
  InputStateWriter,
  readInputState,
} from "../src/interactive/input-state";
import { TranscriptWriter } from "../src/session/transcript";
import { BlobStore, hashBytes } from "../src/session/file-history";
import { CredentialStore } from "../src/auth/credentials";
import { loadIdentity } from "./helpers/env";
import { searchContentTool } from "../src/tools/search-content";
import { findFilesTool } from "../src/tools/find-files";
import { storeDirectoryReference } from "../src/session/private-storage";
import { allSessions, searchSessions } from "../src/session/discovery";
import { readTranscript } from "../src/session/sessions";
import type { CredentialVault } from "../src/platform/credential-vault";
import {
  privateStorageScope,
  openPrivateStorage,
  storeRead,
  storeWrite,
  storeAppend,
  storeList,
  storeExists,
  storeRemove,
  storeRename,
  storeReference,
} from "../src/session/private-storage";

class Vault implements CredentialVault {
  readonly entries = new Map<string, string>();
  read(service: string, account: string) {
    return this.entries.get(service + account);
  }
  write(service: string, account: string, value: string) {
    this.entries.set(service + account, value);
  }
  remove(service: string, account: string) {
    this.entries.delete(service + account);
  }
}
test("TECH — a legacy file changed during encryption is preserved and migration refuses to delete its newer version", async () => {
  const ws = workspace(),
    vault = new Vault(),
    file = join(ws.configHome, "input-history.jsonl");
  writeFileSync(file, "original history");
  const original = ArchiveFiles.prototype.write;
  let changed = false;
  const spy = spyOn(ArchiveFiles.prototype, "write").mockImplementation(
    function (this: ArchiveFiles, path: string, bytes: Uint8Array) {
      original.call(this, path, bytes);
      if (!changed && !path.endsWith("index")) {
        changed = true;
        writeFileSync(file, "newer history from another writer");
      }
    },
  );
  try {
    await expect(
      privateStorageScope(() =>
        openPrivateStorage({
          root: ws.configHome,
          service: "fixture",
          vault,
          enabled: true,
        }),
      ),
    ).rejects.toThrow("modifié");
    expect(readFileSync(file, "utf8")).toBe(
      "newer history from another writer",
    );
  } finally {
    spy.mockRestore();
  }
});
function noClearCopies(root: string, witness: string): void {
  for (const name of readdirSync(root)) {
    expect(name).not.toContain(witness);
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) noClearCopies(path, witness);
    else expect(readFileSync(path).toString()).not.toContain(witness);
  }
}
async function fixture(
  action: (ws: ReturnType<typeof workspace>, vault: Vault) => Promise<void>,
) {
  const ws = workspace(),
    vault = new Vault();
  await privateStorageScope(async () => {
    const close = await openPrivateStorage({
      root: ws.configHome,
      service: "fixture",
      vault,
      enabled: true,
    });
    try {
      await action(ws, vault);
    } finally {
      close();
    }
  });
}
test("TECH — private storage hides logical names and contents, lists, renames and reopens using only its vault", async () => {
  const ws = workspace(),
    vault = new Vault(),
    file = join(
      ws.configHome,
      "sessions",
      "private-project",
      "witness-file.jsonl",
    );
  await privateStorageScope(async () => {
    const close = await openPrivateStorage({
      root: ws.configHome,
      service: "fixture",
      vault,
      enabled: true,
    });
    try {
      storeWrite(file, Buffer.from("private witness\n"));
      storeAppend(file, "second\n");
      expect(storeRead(file, "utf8")).toBe("private witness\nsecond\n");
      expect(storeList(join(ws.configHome, "sessions"))).toEqual([
        "private-project",
      ]);
      expect(
        storeList(join(ws.configHome, "sessions", "private-project")),
      ).toEqual(["witness-file.jsonl"]);
      const renamed = file + ".renamed";
      storeRename(file, renamed);
      expect(storeExists(file)).toBe(false);
      expect(storeRead(renamed, "utf8")).toContain("private witness");
      storeRename(renamed, file);
      for (const name of readdirSync(join(ws.configHome, "archives-v1"))) {
        expect(name).not.toContain("private");
        expect(name).not.toContain("witness");
        expect(
          readFileSync(join(ws.configHome, "archives-v1", name)).toString(),
        ).not.toContain("private witness");
      }
    } finally {
      close();
    }
  });
  await privateStorageScope(async () => {
    const close = await openPrivateStorage({
      root: ws.configHome,
      service: "fixture",
      vault,
      enabled: true,
    });
    try {
      expect(storeRead(file, "utf8")).toContain("second");
      storeRemove(file);
      expect(storeExists(file)).toBe(false);
    } finally {
      close();
    }
  });
  await expect(
    privateStorageScope(() =>
      openPrivateStorage({
        root: ws.configHome,
        service: "fixture",
        vault: new Vault(),
        enabled: true,
      }),
    ),
  ).rejects.toThrow("Clé");
});
test("TECH — encryption activation migrates legacy stores before marking protected, preserves settings and rejects tampering", async () => {
  const ws = workspace(),
    vault = new Vault(),
    file = join(ws.configHome, "input-history.jsonl"),
    settings = join(ws.configHome, "settings.json");
  writeFileSync(file, "legacy witness\n");
  writeFileSync(settings, '{"theme":"plain"}');
  await privateStorageScope(async () => {
    const close = await openPrivateStorage({
      root: ws.configHome,
      service: "fixture",
      vault,
      enabled: true,
    });
    try {
      expect(storeRead(file, "utf8")).toBe("legacy witness\n");
      expect(readFileSync(settings, "utf8")).toContain("plain");
      expect(() => readFileSync(file)).toThrow();
      const objects = readdirSync(join(ws.configHome, "archives-v1")).filter(
        (name) => /^[a-f0-9]{64}$/.test(name),
      );
      expect(objects).toHaveLength(1);
      const path = join(ws.configHome, "archives-v1", objects[0]!),
        bytes = readFileSync(path);
      bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1;
      writeFileSync(path, bytes);
      expect(() => storeRead(file)).toThrow("altérées");
    } finally {
      close();
    }
  });
  await expect(
    privateStorageScope(() =>
      openPrivateStorage({
        root: ws.configHome,
        service: "fixture",
        vault,
        enabled: false,
      }),
    ),
  ).rejects.toThrow("chiffr");
});
test("SPEC-SES-001/CA-11 — encrypted CLI sessions reopen with their history and support session discovery", async () => {
  const ws = workspace(),
    vault = new Vault();
  const userConfig = {
    storage: { encryption: { enabled: true } },
    engine: { nonInteractive: { persistSession: true } },
  };
  const first = await cli(
    ["--non-interactive", "--result-format", "json", "private witness"],
    ws,
    {
      provider: new ScriptedProvider([{ text: "answer witness" }]),
      userConfig,
      extra: { credentialVault: vault },
    },
  );
  expect(first.stderr).not.toContain("Erreur");
  expect(first.code).toBe(0);
  let observed = false;
  const second = await cli(["--non-interactive", "--reopen-last", "next"], ws, {
    provider: new ScriptedProvider([
      (request) => {
        observed = JSON.stringify(request.history).includes("private witness");
        return { text: "continued" };
      },
    ]),
    userConfig,
    extra: { credentialVault: vault },
  });
  expect(second.code).toBe(0);
  expect(observed).toBe(true);
  await privateStorageScope(async () => {
    const close = await openPrivateStorage({
      root: ws.configHome,
      service: "pilote-dev:archives",
      vault,
      enabled: true,
    });
    try {
      const results = await searchSessions(
        allSessions(join(ws.configHome, "sessions")),
        "private witness",
        { limit: 10, signal: new AbortController().signal },
      );
      expect(results[0]?.first).toContain("private witness");
    } finally {
      close();
    }
  });
  noClearCopies(ws.configHome, "private witness");
});
test("SPEC-AGT-007/CA-03 — user agent memories and their index are encrypted and read through opaque references", async () =>
  fixture(async (ws) => {
    const memory = new AgentMemory({
      configDir: ws.configHome,
      projectDir: ws.project,
      indexFile: "index.md",
      redact: (text) => text,
    }).open("reviewer", "user");
    memory.put(
      "preference.md",
      "---\nname: Private witness\ndescription: Testing preference\ntype: feedback\n---\nprivate agent witness\n",
    );
    expect(memory.read("preference.md").text).toContain(
      "private agent witness",
    );
    expect(memory.index()).toContain("Private witness");
    expect(memory.instructions()).toContain("archive-dir:v1:");
    expect(memory.instructions()).not.toContain(ws.configHome);
    noClearCopies(ws.configHome, "private agent witness");
  }));
test("SPEC-AGT-013/CA-02 — a team mailbox and task list contain no clear message", async () =>
  fixture(async (ws) => {
    const team = new Teams({
      folder: join(ws.configHome, "teams"),
      enabled: () => true,
      maxMembers: () => 4,
      maxBytes: () => 10000,
      shutdownMs: () => 10,
      redact: (text) => text,
      notify: () => {},
      run: async () => ({ id: "child", text: "done", isError: false }),
    });
    const info = team.form("test");
    team.spawn("worker", "work");
    team.send("lead", "worker", "private mailbox witness");
    expect(storeRead(join(info.folder, "mail-worker.jsonl"), "utf8")).toContain(
      "private mailbox witness",
    );
    noClearCopies(ws.configHome, "private mailbox witness");
    await team.close();
  }));
test("SPEC-AGT-016/CA-03 — captured background output remains available to the panel and model without a clear file", async () =>
  fixture(async (ws) => {
    const background = new BackgroundTasks({
      dir: join(ws.configHome, "sessions", "fixture", "tasks"),
      maxOutputBytes: 10000,
      monitorMaxLinesPerMinute: 100,
      monitorWindowMs: 50,
    });
    const task = background.start(
      "shell",
      "fixture",
      async (_signal, write) => {
        write("private background witness");
        return { status: "completed", exitCode: 0 };
      },
    );
    await background.wait(task.id, 1000);
    expect(background.tail(task.id, 2000)).toContain(
      "private background witness",
    );
    noClearCopies(ws.configHome, "private background witness");
    await background.stopAll();
  }));
test("SPEC-MCP-020/CA-03 — a large saved connector result is encrypted and read in full through its opaque reference", async () =>
  fixture(async (ws) => {
    const store = new ResultStore(
        join(ws.configHome, "sessions", "fixture", "tool-results"),
      ),
      witness = "private connector witness\n".repeat(100),
      reference = store.store("call", witness);
    expect(reference).toMatch(/^archive:v1:/);
    const tool = archiveAccessTool(readFileTool as never),
      input = { path: reference } as never;
    const ctx = {
      ...testToolFields(),
      cwd: ws.project,
      home: ws.home,
      platform: currentPlatform(),
      allowedDirectories: [ws.project],
      extraReadableDirectories: [store.dir],
      signal: new AbortController().signal,
    };
    expect(tool.validate?.(input, ctx)).toBeUndefined();
    expect(tool.permissionContribution?.(input, ctx)).toBe("allow");
    const result = await tool.execute(input, ctx);
    expect(result.isError).toBe(false);
    expect(
      JSON.stringify(result.content).match(/private connector witness/g),
    ).toHaveLength(100);
    noClearCopies(ws.configHome, "private connector witness");
  }));
test("SPEC-MOT-040/CA-03 — session notes and checkpoint stay encrypted and can be reread", async () =>
  fixture(async (ws) => {
    const notes = new SessionNotes(
      join(ws.configHome, "sessions", "fixture"),
      (text) => text,
    );
    notes.initialize();
    writeAtomic(
      notes.path,
      Buffer.from("# Session notes\n\n## Goal\nprivate notes witness\n"),
      currentPlatform(),
      true,
    );
    notes.checkpoint(3, 0);
    expect(notes.snapshot()?.content).toContain("private notes witness");
    noClearCopies(ws.configHome, "private notes witness");
  }));
test("SPEC-OBS-016/CA-02 — the default terminal recording is encrypted without a temporary clear copy", async () =>
  fixture(async (ws) => {
    const path = join(ws.configHome, "sessions", "fixture", "terminal.cast"),
      cast = new Asciicast(path, 80, 24, (message) => {
        throw new Error(message);
      });
    cast.output("private cast witness");
    cast.close();
    const lines = storeRead(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0].version).toBe(2);
    expect(lines[1][2]).toBe("private cast witness");
    noClearCopies(ws.configHome, "private cast witness");
  }));
test("SPEC-SES-001/CA-12 — an encrypted transcript grant is read on stdout in its own session context with no clear copy", async () =>
  fixture(async (ws) => {
    const path = join(ws.configHome, "sessions", "fixture.jsonl");
    storeWrite(path, "private hook witness\n");
    const access = new TranscriptAccess(() => storeRead(path)),
      grant = await access.grant();
    let text = "";
    try {
      await readTranscriptReference(
        grant.reference,
        (value) => (text += value),
      );
      expect(text).toContain("private hook witness");
      noClearCopies(ws.configHome, "private hook witness");
    } finally {
      grant.release();
      access.close();
    }
  }));
test("SPEC-MOT-036/CA-04 — an encrypted memory and index are saved by the CLI and recalled by the next session", async () => {
  const ws = workspace(),
    vault = new Vault(),
    userConfig = {
      storage: { encryption: { enabled: true } },
      memory: {
        automatic: { enabled: true },
        recall: { enabled: false },
        autoExtraction: { enabled: false },
        session: { enabled: false },
      },
    };
  const provider = new ScriptedProvider([
    (request) => {
      const folder = /Memory folder: (archive-dir:v1:[a-f0-9]{64})/.exec(
        request.system.map((block) => block.text).join("\n"),
      )?.[1];
      expect(folder).toBeDefined();
      return {
        toolCalls: [
          {
            name: "write_file",
            input: {
              path: folder + "/tests.md",
              content:
                "---\nname: Encrypted preference\ndescription: Testing\ntype: feedback\n---\nprivate durable witness\n",
            },
          },
        ],
      };
    },
    { text: "saved" },
  ]);
  const result = await cli(["--non-interactive", "Remember this."], ws, {
    userConfig,
    provider,
    extra: { credentialVault: vault },
  });
  expect(result.code).toBe(0);
  const again = new ScriptedProvider([{ text: "recalled" }]);
  await cli(["--non-interactive", "Continue"], ws, {
    userConfig,
    provider: again,
    extra: { credentialVault: vault },
  });
  expect(
    again.requests[0]!.system.map((block) => block.text).join("\n"),
  ).toContain("[Encrypted preference](archive:v1:");
  noClearCopies(ws.configHome, "private durable witness");
});
test("SPEC-OUT-020/CA-05 — a task title is encrypted in the CLI transcript and remains available after reopening", async () => {
  const ws = workspace(),
    vault = new Vault(),
    userConfig = {
      storage: { encryption: { enabled: true } },
      engine: { nonInteractive: { persistSession: true } },
    };
  const provider = new ScriptedProvider([
    {
      toolCalls: [
        {
          name: "work_item_create",
          input: { subject: "private task witness" },
        },
      ],
    },
    { text: "saved" },
  ]);
  const result = await cli(["--non-interactive", "Plan work"], ws, {
    userConfig,
    provider,
    extra: { credentialVault: vault },
  });
  expect(result.code).toBe(0);
  await privateStorageScope(async () => {
    const close = await openPrivateStorage({
      root: ws.configHome,
      service: "pilote-dev:archives",
      vault,
      enabled: true,
    });
    try {
      const sessions = allSessions(join(ws.configHome, "sessions"));
      expect(
        readTranscript(sessions[0]!.path).records.some(
          (record) =>
            record.type === "system" &&
            record.data["event"] === "todo_list" &&
            JSON.stringify(record.data["tasks"]).includes(
              "private task witness",
            ),
        ),
      ).toBe(true);
    } finally {
      close();
    }
  });
  noClearCopies(ws.configHome, "private task witness");
});
test("SPEC-SES-001/CA-07 — a locked vault refuses persistent startup without storing the request in cleartext", async () => {
  const ws = workspace(),
    vault: CredentialVault = {
      read() {
        throw new Error("locked");
      },
      write() {
        throw new Error("locked");
      },
      remove() {},
    },
    provider = new ScriptedProvider([]);
  const result = await cli(
    ["--non-interactive", "private locked witness"],
    ws,
    {
      userConfig: {
        storage: { encryption: { enabled: true } },
        engine: { nonInteractive: { persistSession: true } },
      },
      provider,
      extra: { credentialVault: vault },
    },
  );
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("coffre");
  expect(provider.requests).toHaveLength(0);
  noClearCopies(ws.configHome, "private locked witness");
});
test("SPEC-SES-001/CA-05 — copying all data without the vault key cannot recover any protected content", async () =>
  fixture(async (ws) => {
    const path = join(ws.configHome, "sessions", "private.jsonl");
    storeWrite(path, "private copied witness");
    noClearCopies(ws.configHome, "private copied witness");
    const copied = join(ws.home, "copied-profile");
    cpSync(ws.configHome, copied, { recursive: true });
    await expect(
      privateStorageScope(() =>
        openPrivateStorage({
          root: copied,
          service: "fixture",
          vault: new Vault(),
          enabled: true,
        }),
      ),
    ).rejects.toThrow("Clé");
    noClearCopies(copied, "private copied witness");
  }));
test("SPEC-SES-001/CA-10 — authenticated ciphertext damage is reported by session reading and never treated as a partial JSON line", async () =>
  fixture(async (ws) => {
    const path = join(ws.configHome, "sessions", "fixture.jsonl");
    storeWrite(path, '{"id":"record","type":"user","data":{}}\n');
    const id = storeReference(path).slice(11),
      object = join(ws.configHome, "archives-v1", id),
      bytes = readFileSync(object);
    bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1;
    writeFileSync(object, bytes);
    expect(() => readTranscript(path)).toThrow("altérées");
    const tool = archiveAccessTool(readFileTool as never),
      ctx = {
        ...testToolFields(),
        cwd: ws.project,
        home: ws.home,
        platform: currentPlatform(),
        allowedDirectories: [ws.project],
        signal: new AbortController().signal,
      };
    const result = await tool.execute(
      { path: storeReference(path) } as never,
      ctx,
    );
    expect(JSON.stringify(result)).toContain("altered");
  }));
test("SPEC-SES-001/CA-04 — transcripts, attachments, history, drafts, snapshots and results contain no clear witness in any application copy", async () =>
  fixture(async (ws) => {
    const witness = "private inventory witness",
      writer = new TranscriptWriter({
        sessionsDir: join(ws.configHome, "sessions"),
        projectRealPath: ws.project,
        contentInlineThreshold: 10,
      });
    writer.append("user", { content: [{ type: "text", text: witness }] });
    writer.append("assistant", { text: witness });
    writer.close();
    const history = new InputHistory({
      path: join(ws.configHome, "input-history.jsonl"),
      dir: ws.project,
      scope: "global",
      maxEntries: 100,
      retentionDays: 30,
      enabled: true,
      contentInlineThreshold: 10,
      warn: (message) => {
        throw new Error(message);
      },
    });
    history.add(witness);
    expect(history.entries()[0]?.text).toBe(witness);
    const draft = new InputStateWriter(
      join(writer.sessionDir, "input-state.json"),
      true,
    );
    draft.update({ draft: witness, queue: [witness], stash: [witness] });
    draft.flush();
    expect(readInputState(draft.path)?.draft).toBe(witness);
    const blobs = new BlobStore(join(writer.sessionDir, "file-history")),
      bytes = Buffer.from(witness);
    blobs.put(hashBytes(bytes), bytes);
    expect(blobs.get(hashBytes(bytes))).toEqual(bytes);
    new ResultStore(join(writer.sessionDir, "tool-results")).store(
      "fixture",
      witness,
    );
    expect(readTranscript(writer.path).records[0]!.data["content"]).toEqual([
      { type: "text", text: witness },
    ]);
    noClearCopies(ws.configHome, witness);
  }));
test("SPEC-PER-027/CA-04 — clearing provider credentials preserves the actual archive key and encrypted history", async () => {
  const ws = workspace(),
    vault = new Vault(),
    options = { root: ws.configHome, service: "fixture", vault, enabled: true };
  await privateStorageScope(async () => {
    const close = await openPrivateStorage(options);
    try {
      storeWrite(
        join(ws.configHome, "sessions", "fixture.jsonl"),
        "private logout witness",
      );
    } finally {
      close();
    }
  });
  const credentials = new CredentialStore({
    service: loadIdentity().get("KEYCHAIN_SERVICE"),
    configDir: ws.configHome,
    vault,
    preference: "keychain",
  });
  await credentials.save("provider:fixture", "fixture-only-credential");
  await credentials.clear();
  expect(await credentials.get("provider:fixture")).toBeUndefined();
  await privateStorageScope(async () => {
    const close = await openPrivateStorage(options);
    try {
      expect(
        storeRead(join(ws.configHome, "sessions", "fixture.jsonl"), "utf8"),
      ).toContain("private logout witness");
    } finally {
      close();
    }
  });
});
test("TECH — opaque directory references support file discovery and content search without revealing store paths", async () =>
  fixture(async (ws) => {
    const root = join(ws.configHome, "memory", "fixture"),
      file = join(root, "fact.md");
    storeWrite(file, "private search witness");
    const reference = storeDirectoryReference(root);
    const ctx = {
      ...testToolFields(),
      cwd: ws.project,
      home: ws.home,
      platform: currentPlatform(),
      allowedDirectories: [ws.project],
      signal: new AbortController().signal,
    };
    const search = archiveAccessTool(searchContentTool as never),
      found = archiveAccessTool(findFilesTool as never);
    const result = await search.execute(
      { path: reference, pattern: "private search", mode: "lines" } as never,
      ctx,
    );
    expect(JSON.stringify(result)).toContain("private search witness");
    expect(JSON.stringify(result)).toContain("archive:v1:");
    expect(JSON.stringify(result)).not.toContain(ws.configHome);
    const listing = await found.execute(
      { path: reference, pattern: "*.md" } as never,
      ctx,
    );
    expect(JSON.stringify(listing)).toContain("archive:v1:");
    expect(JSON.stringify(listing)).not.toContain(ws.configHome);
  }));
test("TECH — deleting the encrypted inventory never replaces its archive key or starts a new empty store", async () => {
  const ws = workspace(),
    vault = new Vault(),
    options = { root: ws.configHome, service: "fixture", vault, enabled: true };
  await privateStorageScope(async () => {
    const close = await openPrivateStorage(options);
    try {
      storeWrite(
        join(ws.configHome, "sessions", "one.jsonl"),
        "preserved witness",
      );
      unlinkSync(join(ws.configHome, "archives-v1", "index"));
      expect(() =>
        storeRead(join(ws.configHome, "sessions", "one.jsonl")),
      ).toThrow("Inventaire");
    } finally {
      close();
    }
  });
  const before = [...vault.entries];
  await expect(
    privateStorageScope(() => openPrivateStorage(options)),
  ).rejects.toThrow("Inventaire");
  expect([...vault.entries]).toEqual(before);
  vault.entries.clear();
  await expect(
    privateStorageScope(() => openPrivateStorage(options)),
  ).rejects.toThrow("Clé");
  expect(vault.entries.size).toBe(0);
  noClearCopies(ws.configHome, "preserved witness");
});
test("TECH — an altered encrypted attachment refuses its transcript instead of silently skipping the user record", async () =>
  fixture(async (ws) => {
    const writer = new TranscriptWriter({
      sessionsDir: join(ws.configHome, "sessions"),
      projectRealPath: ws.project,
      contentInlineThreshold: 10,
    });
    writer.append("user", {
      content: [{ type: "text", text: "private attachment witness" }],
    });
    writer.close();
    const root = join(ws.configHome, "content"),
      file = storeList(root).find((name) => name.endsWith(".blob"))!,
      object = join(
        ws.configHome,
        "archives-v1",
        storeReference(join(root, file)).slice(11),
      ),
      bytes = readFileSync(object);
    bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1;
    writeFileSync(object, bytes);
    expect(() => readTranscript(writer.path)).toThrow("altérées");
  }));
