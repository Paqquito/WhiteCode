// Supports: SPEC-EXT-038/CA-01 (actual discover/use calls and independent human approval).
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Identity } from "../src/identity/identity";
import { loadIdentity, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-EXT-038/CA-01 — invoking a discovered remote skill requires human approval before its body is requested", async () => {
  for (const accepted of [false, true]) {
    const ws = workspace(),
      original = loadIdentity(),
      identity = new Identity({
        ...original.resolved,
        values: {
          ...original.resolved.values,
          SERVICE_MARKETPLACE: {
            value: "https://catalog.example.test/",
            origin: "provided",
          },
        },
      });
    const content = "Check boundary values before proposing changes.",
      sha256 = createHash("sha256").update(content).digest("hex"),
      requests: Array<{ path: string; body: unknown }> = [];
    let confirmations = 0;
    const network = (async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(
        path.endsWith("/discover")
          ? {
              skills: [
                {
                  id: "boundary-tests",
                  name: "boundary-testing",
                  description: "Check numeric boundary values.",
                  sha256,
                },
              ],
            }
          : { content },
      );
    }) as typeof fetch;
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: "discover_skills",
            input: {
              description: "Test project-secret-witness at src/private.ts",
            },
          },
        ],
      },
      {
        toolCalls: [{ name: "use_skill", input: { name: "boundary-testing" } }],
      },
      (request) => {
        const history = JSON.stringify(request.history);
        expect(history).toContain(accepted ? content : "not approved");
        return { text: "Discovery decision respected" };
      },
    ]);
    const h = new Host(ws, {
      identity,
      provider,
      extra: { skillCatalogFetch: network },
      init: { decisionAuthority: true },
      userConfig: {
        skills: { discovery: { remote: true } },
        engine: { control: { allowEscalation: true } },
      },
      answers: {
        confirm_escalation: (params) => {
          confirmations++;
          expect(
            requests.every((request) => request.path.endsWith("/discover")),
          ).toBe(true);
          return {
            decision: accepted ? "confirm" : "decline",
            escalationId: params["escalationId"],
          };
        },
      },
    });
    try {
      h.user("Find a suitable testing skill");
      await h.waitFor((message) => message.type === "turn_completed");
      expect(confirmations).toBe(1);
      expect(
        requests.filter((request) => !request.path.endsWith("/discover")),
      ).toHaveLength(accepted ? 1 : 0);
      expect(requests[0]?.body).toEqual({ intent: "testing" });
      expect(JSON.stringify(requests)).not.toContain("project-secret-witness");
    } finally {
      h.feed.end();
      const result = await h.finish();
      if (result.code !== 0) throw new Error(result.stderr + result.stdout);
    }
  }
}, 15000);
