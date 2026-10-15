// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { readConnectorZip } from "../src/platform/connector-zip";
import { fixtureZip } from "./helpers/connector-zip";

test("SPEC-EXT-016/CA-02 — an archive containing a parent traversal is rejected before extraction", () => {
  for (const path of [
    "../../x",
    "/absolute",
    "C:/windows/x",
    "a\\..\\x",
    "a/../x",
    "a/CON",
    "a/x.",
  ])
    expect(() =>
      readConnectorZip(
        fixtureZip({ "manifest.json": "{}", [path]: "bad" }),
        1048576,
      ),
    ).toThrow();
});
test("TECH — ordinary stored and deflated connector archives decode with CRC verification and portable distinct paths", () => {
  for (const compressed of [false, true]) {
    const files = readConnectorZip(
      fixtureZip(
        { "manifest.json": "{}", "server/main.js": "server fixture" },
        compressed,
      ),
      1048576,
    );
    expect(files.get("server/main.js")?.toString()).toBe("server fixture");
  }
  const zip = fixtureZip({ "manifest.json": "{}" });
  zip[31] = zip[31]! ^ 1;
  expect(() => readConnectorZip(zip, 1048576)).toThrow();
  expect(() =>
    readConnectorZip(fixtureZip({ "A.txt": "a", "a.txt": "b" }), 1048576),
  ).toThrow();
  expect(() =>
    readConnectorZip(fixtureZip({ "large.txt": "x".repeat(2000) }, true), 1000),
  ).toThrow();
});
