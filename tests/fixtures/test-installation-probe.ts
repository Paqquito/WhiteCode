// Supports: SPEC-INS-006 (test-profile-only private distribution).
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { configuredInstallation } from "../../src/installation/runtime";
import { EnvironmentView } from "../../src/config/environment";
import { Settings } from "../../src/config/settings";
import { systemInfo } from "../../src/platform/system";
import { loadIdentity, workspace } from "../helpers/env";
import { buildFlag } from "../../src/extension-points/build-flags" with { type: "macro" };
const identity = loadIdentity(),
  ws = workspace(),
  bytes = Buffer.from("private test artifact"),
  version = "999999.0.1",
  requests: string[] = [],
  prefix = identity.get("ENV_PREFIX");
if (!buildFlag("update_prerelease_channel"))
  throw Error("The probe requires a test build.");
const env = new EnvironmentView(prefix, {
  [prefix + "TEST_INSTALL_SERVICE"]: "https://private.example.test/install/",
  [prefix + "TEST_INSTALL_TOKEN"]: "fixture-ci-only",
});
const store = configuredInstallation({
  identity,
  env,
  system: systemInfo(),
  configDir: ws.configHome,
  settings: Settings.load({ sources: [], projectTrusted: false }),
  report: () => {},
  fetch: (async (input, init) => {
    const url = new URL(String(input));
    if (
      url.origin !== "https://private.example.test" ||
      new Headers(init?.headers).get("authorization") !==
        "Bearer fixture-ci-only" ||
      init?.redirect !== "error"
    )
      throw Error("Private distribution was not authenticated safely.");
    requests.push(url.pathname);
    if (url.pathname.endsWith(".json"))
      return Response.json({
        schemaVersion: 1,
        version,
        artifacts: {
          [store.o.target]: {
            url: "artifact",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.length,
          },
        },
      });
    return new Response(bytes);
  }) as typeof fetch,
});
const release = await store.release(version),
  installed = await store.install(release);
if (
  !readFileSync(installed.path).equals(bytes) ||
  requests.join("|") !== "/install/v1/999999.0.1.json|/install/artifact"
)
  throw Error("Private installation did not download the verified bytes.");
if (
  Object.keys(env.childEnvironment()).some((key) =>
    key.includes("TEST_INSTALL"),
  )
)
  throw Error("Private distribution credentials escaped to a tool child.");
console.log("PRIVATE_TEST_INSTALLATION_PASSED");
