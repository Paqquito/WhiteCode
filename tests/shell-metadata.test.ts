import { expect, test } from "bun:test";
import { ShellMetadataStream } from "../src/tools/shell-metadata";
test("TECH — private shell metadata is removed across every chunk boundary and incomplete frames never reach output", () => {
  const frame = "before\x1enonce:/private/path\x1fafter";
  for (let at = 0; at <= frame.length; at++) {
    let path = "";
    const parser = new ShellMetadataStream("nonce", (value) => (path = value));
    expect(
      parser.push(frame.slice(0, at)) + parser.push(frame.slice(at), true),
    ).toBe("beforeafter");
    expect(path).toBe("/private/path");
  }
  const partial = new ShellMetadataStream("nonce", () => {});
  expect(partial.push("shown\x1enonce:secret", true)).toBe("shown");
});
