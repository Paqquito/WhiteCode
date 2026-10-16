import { expect, test } from "bun:test";
import { EnvironmentView } from "../src/config/environment";

test("TECH — a compatible-service credential is available to configuration and excluded from child environments", () => {
  const credential = "fictitious-compatible-service-key";
  const view = new EnvironmentView("TEST_", { GEMINI_API_KEY: credential, OPENAI_API_KEY: credential, PATH: "executable-path", ORDINARY: "kept" });
  expect(view.public("GEMINI_API_KEY")).toBe(credential);
  expect(view.childEnvironment()).toEqual({ PATH: "executable-path", ORDINARY: "kept", TEST_CHILD_PROCESS: "1" });
});
