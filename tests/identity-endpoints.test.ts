// Supports: SPEC-CAD-002, SPEC-API-028 (public OAuth token endpoint is identity metadata, never a credential), gap E-230.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveIdentityText } from "../src/identity/resolver";
import { ROOT } from "./helpers/env";

const source = () => JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
test("TECH — normative public OAuth token endpoints validate without a secret-field false positive", () => {
  for (const endpoint of ["https://account.example.test/oauth/token", "https://account.example.test/token?tenant=fixture", "http://127.0.0.1:3344/token"]) {
    const input = source(); (input.services ??= {}).SERVICE_OAUTH_TOKEN = endpoint;
    const result = resolveIdentityText(JSON.stringify(input), { version: "0.1.0", strict: true });
    expect(result.issues.filter(issue => issue.severity === "error")).toEqual([]);
    expect(result.identity?.values["SERVICE_OAUTH_TOKEN"]?.value).toBe(endpoint);
  }
});

test("TECH — token endpoint metadata cannot conceal a credential, nested secret or unsafe URL", () => {
  for (const endpoint of ["plaintext-secret", "https://user:password@example.test/token", "https://account.example.test/token#secret", "https://account.example.test/token?api_key=fixture-value", "https://account.example.test/token?access_token=fixture-value", "http://remote.example.test/token", { token: "nested-secret" }]) {
    const input = source(); (input.services ??= {}).SERVICE_OAUTH_TOKEN = endpoint;
    const result = resolveIdentityText(JSON.stringify(input), { version: "0.1.0", strict: true });
    expect(result.identity).toBeUndefined();
    expect(result.issues.some(issue => issue.code === "ERR-17")).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain("plaintext-secret");
  }
  for (const section of ["identity", "compatibility"]) {
    const input = source(); (input[section] ??= {}).SERVICE_OAUTH_TOKEN = "https://account.example.test/token";
    expect(resolveIdentityText(JSON.stringify(input), { version: "0.1.0", strict: true }).identity).toBeUndefined();
  }
  const unknown = source(); (unknown.services ??= {}).SERVICE_OTHER_TOKEN = "https://account.example.test/token";
  expect(resolveIdentityText(JSON.stringify(unknown), { version: "0.1.0", strict: true }).issues.some(issue => issue.code === "ERR-17")).toBe(true);
});
