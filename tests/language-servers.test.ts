import { expect, spyOn, test } from "bun:test";
import { LanguageManager } from "../src/languages/manager";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PROJECT_DIR } from "./helpers/hooks";
import { cli, workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { languageServer } from "./helpers/lsp";
import { ScriptedProvider } from "./helpers/scripted-provider";
const history = (p: ScriptedProvider, index: number) => JSON.stringify(p.requests[index]?.history);
const call = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ name, input }] });

test("SPEC-OUT-003/CA-07, SPEC-INT-006/CA-01 — a language server: a faulty write supplies a diagnostic with its line to the next request", async () => {
  const ws = workspace(), peer = languageServer(ws), path = ws.write("project/code.ts", "const valid = 1;\n");
  const p = new ScriptedProvider([call("read_file", { path }), call("write_file", { path, content: "const BAD = 2;\n" }), { text: "checked" }]);
  const result = await cli(["--non-interactive", "--allow-rule", "write_file", "change"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(result.code).toBe(0); expect(history(p, 2)).toContain("Type mismatch"); expect(history(p, 2)).toContain("code.ts:1");
  expect(readFileSync(path, "utf8")).toBe("const BAD = 2;\n");
  expect(peer.messages().filter((m) => m.method === "started")).toHaveLength(1);
  expect(peer.messages().some((m) => m.method === "shutdown")).toBe(true);
}, 20_000);

test("TECH — language analysis is lazy and all eight navigation operations use the current disk text", async () => {
  const ws = workspace(), peer = languageServer(ws), path = ws.write("project/code.ts", "const value = () => 1;\n");
  const operations = ["go_to_definition", "go_to_implementation", "find_references", "hover", "document_symbols", "workspace_symbols", "incoming_calls", "outgoing_calls"];
  const p = new ScriptedProvider([{ text: "no analysis" }, ...operations.map((operation) => call("code_intelligence", operation === "workspace_symbols" ? { operation, query: "value" } : { operation, file_path: path, line: 1, character: 7 })), { text: "done" }]);
  // The first response ends the turn, so this run cannot start a server.
  const first = await cli(["--non-interactive", "question"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(first.code).toBe(0); expect(peer.messages()).toHaveLength(0);
  const next = new ScriptedProvider([...operations.map((operation) => call("code_intelligence", operation === "workspace_symbols" ? { operation, query: "value" } : { operation, file_path: path, line: 1, character: 7 })), { text: "done" }]);
  const result = await cli(["--non-interactive", "navigate"], ws, { provider: next, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(result.code).toBe(0);
  for (let i = 1; i <= 8; i++) expect(history(next, i)).not.toContain('"isError":true');
  expect(history(next, 8)).toContain("value");
  const methods = peer.messages().map((m) => m.method);
  for (const method of ["textDocument/definition", "textDocument/implementation", "textDocument/references", "textDocument/hover", "textDocument/documentSymbol", "workspace/symbol", "callHierarchy/incomingCalls", "callHierarchy/outgoingCalls"]) expect(methods).toContain(method);
}, 20_000);

test("TECH — navigation never reveals a denied or outside location and refuses server-driven edits", async () => {
  const ws = workspace(), path = ws.write("project/code.ts", "const value = 1;"), secret = ws.write("project/hidden.ts", "SECRET_SENTINEL"), outside = ws.write("outside.ts", "OUTSIDE_SENTINEL");
  const locations = [path, secret, outside].map((p) => ({ uri: pathToFileURL(p).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }));
  const peer = languageServer(ws, { locations, applyEdit: true });
  const p = new ScriptedProvider([call("code_intelligence", { operation: "find_references", file_path: path, line: 1, character: 1 }), { text: "done", delayMs: 50 }]);
  const result = await cli(["--non-interactive", "--deny-rule", "read_file(**/hidden.ts)", "navigate"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(result.code).toBe(0); expect(history(p, 1)).toContain("const value"); expect(history(p, 1)).not.toContain("SECRET_SENTINEL"); expect(history(p, 1)).not.toContain("OUTSIDE_SENTINEL");
  expect(readFileSync(secret, "utf8")).toBe("SECRET_SENTINEL");
  expect(peer.messages().find((m) => m.id === "server-edit" && m.result)?.result.applied).toBe(false);
}, 20_000);

test("TECH — a navigation-specific denial filters returned locations, including decoded UTF-16 sources", async () => {
  const ws = workspace(), path = ws.write("project/code.ts", ""), secret = ws.write("project/hidden.ts", "SECRET_SENTINEL");
  writeFileSync(path, Buffer.concat([Buffer.from([255, 254]), Buffer.from("const value = 'é😀';", "utf16le")]));
  const locations = [path, secret].map((p) => ({ uri: pathToFileURL(p).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }));
  const peer = languageServer(ws, { locations });
  const p = new ScriptedProvider([call("code_intelligence", { operation: "find_references", file_path: path, line: 1, character: 1 }), { text: "done" }]);
  const result = await cli(["--non-interactive", "--deny-rule", "code_intelligence(**/hidden.ts)", "navigate"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(result.code).toBe(0); expect(history(p, 1)).not.toContain("SECRET_SENTINEL"); expect(history(p, 1)).toContain("const value = 'é😀';");
  expect(peer.messages().find((m) => m.method === "textDocument/didOpen").params.textDocument.text).toBe("const value = 'é😀';");
}, 20_000);

test("TECH — stale diagnostic versions are ignored even with passive diagnostics enabled", async () => {
  const ws = workspace(), peer = languageServer(ws, { stale: true }), path = ws.write("project/code.ts", "const valid = 1;");
  const p = new ScriptedProvider([call("read_file", { path }), call("write_file", { path, content: "const BAD = 2;" }), { text: "done", delayMs: 100 }]);
  const result = await cli(["--non-interactive", "--allow-rule", "write_file", "change"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } }, tools: { edit: { diagnosticsWait: 200 } } } });
  expect(result.code).toBe(0); expect(history(p, 2)).not.toContain("Type mismatch"); expect(peer.messages().some((m) => m.method === "initialized")).toBe(true);
}, 20_000);

test("TECH — the other-file diagnostic cap is respected when the edited file has no publication", async () => {
  for (const limit of [0, 1]) {
    const ws = workspace(), path = ws.write("project/code.ts", "const value = 1;"), others = [ws.write("project/one.ts", "one"), ws.write("project/two.ts", "two")];
    const peer = languageServer(ws, { publishTarget: false, otherUris: others.map((path) => pathToFileURL(path).href) });
    const p = new ScriptedProvider([call("read_file", { path }), call("write_file", { path, content: "const BAD = 1;" }), { text: "done" }]);
    const result = await cli(["--non-interactive", "--allow-rule", "write_file", "change"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration }, passiveDiagnostics: false }, tools: { edit: { diagnosticsWait: 400, diagnosticsMaxOtherFiles: limit } } } });
    expect(result.code).toBe(0); expect(history(p, 2).split("OTHER_ERROR")).toHaveLength(limit + 1);
  }
}, 20_000);

test("TECH — a non-UTF-16 server is refused before document content is sent", async () => {
  const ws = workspace(), peer = languageServer(ws, { encoding: "utf-8" }), path = ws.write("project/code.ts", "const value = 1;");
  const p = new ScriptedProvider([call("code_intelligence", { operation: "hover", file_path: path, line: 1, character: 1 }), { text: "done" }]);
  const result = await cli(["--non-interactive", "navigate"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(result.code).toBe(0); expect(history(p, 1)).toContain("Unsupported language server position encoding"); expect(peer.messages().some((m) => m.method === "textDocument/didOpen")).toBe(false);
}, 20_000);

test("TECH — an approved extension supplies language declarations; minimal and untrusted project configurations cannot start them", async () => {
  const ws = workspace(), peer = languageServer(ws), path = ws.write("project/code.ts", "const value = 1;");
  const manifest = ws.write("extension/extension.json", JSON.stringify({ name: "analysis", version: "1.0.0", description: "Test language analysis" }));
  ws.write("extension/language-servers.json", JSON.stringify({ servers: { types: peer.declaration } }));
  const { dirname } = await import("node:path");
  const p = new ScriptedProvider([call("code_intelligence", { operation: "hover", file_path: path, line: 1, character: 1 }), { text: "done" }]);
  const result = await cli(["--non-interactive", "--extension-dir", dirname(manifest), "navigate"], ws, { provider: p, env: productEnv(ws) });
  expect(result.code).toBe(0); expect(history(p, 1)).toContain("test function"); expect(result.stderr).not.toContain("languageServers");
  const count = peer.messages().filter((m) => m.method === "started").length;
  const minimal = await cli(["--non-interactive", "--minimal", "question"], ws, { provider: new ScriptedProvider([{ text: "done" }]), env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(minimal.code).toBe(0); expect(peer.messages().filter((m) => m.method === "started")).toHaveLength(count);
  ws.write(`project/${PROJECT_DIR}/settings.json`, JSON.stringify({ lsp: { servers: { types: peer.declaration } } }));
  const untrusted = new ScriptedProvider([call("read_file", { path }), { text: "done", delayMs: 100 }]);
  const last = await cli(["--non-interactive", "question"], ws, { provider: untrusted, env: productEnv(ws) });
  expect(last.code).toBe(0); expect(peer.messages().filter((m) => m.method === "started")).toHaveLength(count);
}, 20_000);

test("SPEC-OUT-004/CA-10, SPEC-INT-006/CA-04 — passive diagnostics disabled: the edit result contains the error once and no passive reminder follows", async () => {
  const ws = workspace(), peer = languageServer(ws), path = ws.write("project/code.ts", "const value = 1;\n");
  const p = new ScriptedProvider([call("read_file", { path }), call("edit_file", { path, old_text: "value", new_text: "BAD" }), { text: "checked" }]);
  const result = await cli(["--non-interactive", "--allow-rule", "edit_file", "change"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration }, passiveDiagnostics: false } } });
  expect(result.code).toBe(0); expect(history(p, 2)).toContain("Type mismatch");
  expect(history(p, 2).split("Type mismatch")).toHaveLength(2);
  expect(p.requests[2]!.history.filter((m) => m.role === "user").flatMap((m) => m.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n")).not.toContain("Language server diagnostics");
}, 20_000);

test("SPEC-INT-006/CA-03 — publication after five seconds: edit returns at three seconds and a later request receives the diagnostics", async () => {
  const ws = workspace(), peer = languageServer(ws, { delayMs: 5_000 }), path = ws.write("project/code.ts", "const value = 1;\n");
  const other = ws.write("project/note.txt", "note"); let editResultAt = 0, waitStarted = 0;
  const original = LanguageManager.prototype.changed;
  const timing = spyOn(LanguageManager.prototype, "changed").mockImplementation(function (this: LanguageManager, ...args: Parameters<LanguageManager["changed"]>) {
    waitStarted = performance.now(); return original.apply(this, args);
  });
  try {
  const p = new ScriptedProvider([call("read_file", { path }), call("edit_file", { path, old_text: "value", new_text: "BAD" }), () => { editResultAt = performance.now(); return { delayMs: 2_500, ...call("read_file", { path: other }) }; }, { text: "checked" }]);
  const result = await cli(["--non-interactive", "--allow-rule", "edit_file", "change"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(result.code).toBe(0); expect(history(p, 2)).not.toContain("Type mismatch"); expect(history(p, 3)).toContain("Language server diagnostics"); expect(history(p, 3)).toContain("Type mismatch");
  const changed = peer.messages().find((m) => m.method === "textDocument/didChange" || (m.method === "textDocument/didOpen" && m.params.textDocument.text.includes("BAD")));
  expect(changed).toBeDefined();
  // The wait begins in the product before the child receives didChange; its IPC latency is outside this clock.
  expect(waitStarted).toBeGreaterThan(0);
  expect(editResultAt - waitStarted).toBeGreaterThanOrEqual(2_800); expect(editResultAt - waitStarted).toBeLessThan(4_500);
  } finally { timing.mockRestore(); }
}, 20_000);

test("SPEC-INT-006/CA-02 — repeated crashes: after three restarts the language server is unavailable", async () => {
  const ws = workspace(), peer = languageServer(ws, { crash: true }), path = ws.write("project/code.ts", "const value = 1;\n");
  const p = new ScriptedProvider([call("read_file", { path }), { text: "checked", delayMs: 1_500 }]);
  const result = await cli(["--non-interactive", "change"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration }, maxRestarts: 3 } } });
  expect(result.code).toBe(0); expect(peer.messages().filter((m) => m.method === "started")).toHaveLength(4);
  expect(result.stderr).toContain("Serveur de langage types indisponible");
}, 20_000);

test("SPEC-OUT-040/CA-01 — a references request: locations have relative paths and the source excerpt", async () => {
  const ws = workspace(), peer = languageServer(ws), path = ws.write("project/code.ts", "const value = () => 1;\n");
  const p = new ScriptedProvider([call("code_intelligence", { operation: "find_references", file_path: path, line: 1, character: 7 }), { text: "checked" }]);
  const result = await cli(["--non-interactive", "change"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(result.code).toBe(0); expect(history(p, 1)).toContain("code.ts:1:7"); expect(history(p, 1)).toContain("const value = () => 1;");
  const request = peer.messages().find((m) => m.method === "textDocument/references");
  expect(request.params.position).toEqual({ line: 0, character: 6 });
}, 20_000);

test("SPEC-OUT-040/CA-02 — an unsupported language: code navigation explicitly suggests text search", async () => {
  const ws = workspace(), peer = languageServer(ws), path = ws.write("project/code.unknown", "value");
  const p = new ScriptedProvider([call("code_intelligence", { operation: "hover", file_path: path, line: 1, character: 1 }), { text: "checked" }]);
  const result = await cli(["--non-interactive", "change"], ws, { provider: p, env: productEnv(ws), userConfig: { lsp: { servers: { types: peer.declaration } } } });
  expect(result.code).toBe(0); expect(history(p, 1)).toContain("search_content"); expect(peer.messages()).toHaveLength(0);
}, 20_000);
