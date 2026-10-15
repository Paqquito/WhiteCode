// Actual internal-profile CLI composition probe. Only provider/company service boundaries are scripted.
import { companyFixture } from "../helpers/company";
import { cli } from "../helpers/env";
import { productEnv } from "../helpers/hooks";
import { ScriptedProvider } from "../helpers/scripted-provider";
const f = companyFixture();
f.repository();
await f.login();
f.handle((path) =>
  path === "/api/account/state-captures" ? { accepted: true } : undefined,
);
f.ws.write("project/fixture.txt", "internal snapshot witness");
const prefix = f.identity.get("ENV_PREFIX");
for (const disabled of [false, true]) {
  const before = f.sent.filter(
    (r) => r.path === "/api/account/state-captures",
  ).length;
  const result = await cli(
    ["--non-interactive", "confidential conversation must never be captured"],
    f.ws,
    {
      identity: f.identity,
      provider: new ScriptedProvider([
        { text: "confidential model response must never be captured" },
      ]),
      env: productEnv(f.ws, {
        [prefix + "DISABLE_STATE_CAPTURE"]: String(disabled),
      }),
      extra: f.extra,
      userConfig: {
        sessions: {
          autoTitle: false,
          stateCapture: { forgeOrganizations: ["forge.example.test/org"] },
        },
      },
    },
  );
  if (result.code !== 0) throw Error(result.stderr);
  const captures = f.sent.filter(
    (r) => r.path === "/api/account/state-captures",
  );
  if (captures.length !== before + (disabled ? 0 : 1))
    throw Error("Internal CLI capture activation mismatch.");
  if (
    !disabled &&
    JSON.stringify(captures.at(-1)!.body).includes("confidential")
  )
    throw Error("Conversation leaked into snapshot.");
}
console.log("INTERNAL_STATE_CAPTURE_PROBE_PASSED");
