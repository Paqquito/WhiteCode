// Supports: SPEC-VOX-001 (native helper compilation, without opening any microphone).
import { expect, test } from "bun:test";
import { windowsAudioScript, nativeAudioSources } from "../src/platform/audio";
import { runToCompletion } from "../src/platform/process";
import { workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { findExecutable } from "../src/platform/system";

test("TECH — the current platform audio helper compiles or parses without requesting microphone access", () => {
  const ws = workspace();
  let file: string, args: string[];
  if (process.platform === "win32") {
    file = findExecutable("powershell.exe")!;
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsAudioScript(true), "utf16le").toString("base64"),
    ];
  } else if (process.platform === "darwin") {
    file = findExecutable("swiftc")!;
    args = ["-typecheck", ws.write("audio.swift", nativeAudioSources.macos)];
  } else {
    file = findExecutable("sh")!;
    args = ["-n", ws.write("audio.sh", nativeAudioSources.linux)];
  }
  expect(file).toBeDefined();
  const result = runToCompletion(file, args, {
    cwd: ws.root,
    env: productEnv(ws),
    timeoutMs: 30000,
  });
  if (result.code !== 0) throw Error(result.stderr);
  expect(result.code).toBe(0);
  if (process.platform === "win32")
    expect(result.stdout).toContain("MICROPHONE_HELPER_COMPILED");
}, 40000);
