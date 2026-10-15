// Fictitious company services; real account OAuth storage and configured client routing stay active.
import { spawnSync } from "node:child_process";
import { workspace, loadIdentity } from "./env";
import { Identity } from "../../src/identity/identity";
import { configuredCompanyAccount } from "../../src/auth/company-runtime";
import { Settings } from "../../src/config/settings";
import type { CredentialVault } from "../../src/platform/credential-vault";
export function companyFixture() {
  const ws = workspace(),
    original = loadIdentity(),
    values = {
      SERVICE_REMOTE_SESSIONS: "https://company.example.test/sessions/",
      SERVICE_CONSOLE: "https://company.example.test/console/",
      SERVICE_WEB_APP: "https://company.example.test/",
      SERVICE_OAUTH_AUTHORIZE: "https://company.example.test/authorize",
      SERVICE_OAUTH_TOKEN: "https://company.example.test/token",
      OAUTH_CLIENT_ID: "fixture-client",
    };
  const identity = new Identity({
    ...original.resolved,
    values: {
      ...original.resolved.values,
      ...Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
          name,
          { value, origin: "provided" as const },
        ]),
      ),
    },
  });
  const entries = new Map<string, string>(),
    vault: CredentialVault = {
      read: (service, key) => entries.get(service + key),
      write: (service, key, value) => {
        entries.set(service + key, value);
      },
      remove: (service, key) => {
        entries.delete(service + key);
      },
    };
  const sent: Array<{
    path: string;
    body: unknown;
    authorization: string | null;
  }> = [];
  let handler: (
    path: string,
    body: unknown,
  ) => unknown | Promise<unknown> = () => undefined;
  const network = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/token")
      return Response.json({
        token_type: "Bearer",
        access_token: "fixture-company-only",
        refresh_token: "fixture-refresh-only",
        expires_in: 3600,
      });
    const body: unknown = init?.body
      ? JSON.parse(String(init.body))
      : undefined;
    sent.push({
      path: url.pathname,
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const custom = await handler(url.pathname, body);
    if (custom !== undefined)
      return custom instanceof Response ? custom : Response.json(custom);
    if (url.pathname === "/api/account/profile")
      return Response.json({
        account: "member",
        organization: { id: "org", name: "Organisation" },
        roles: ["member"],
      });
    if (url.pathname.endsWith("/metrics/preferences"))
      return Response.json({
        organizationId: "org",
        eligible: false,
        optOut: true,
      });
    if (url.pathname.endsWith("/policy/limits"))
      return Response.json({
        schemaVersion: 1,
        organizationId: "org",
        version: "one",
        validUntil: Date.now() + 86400000,
        limits: [],
      });
    if (url.pathname.endsWith("/key-status"))
      return Response.json({ repositoryAccessible: true, delegatedKey: true });
    if (url.pathname.endsWith("/repository-access"))
      return Response.json({ accessible: true });
    if (url.pathname === "/api/connectors/list")
      return Response.json({ connectors: [] });
    throw new Error("Unexpected fictitious service route: " + url.pathname);
  }) as typeof fetch;
  const account = configuredCompanyAccount(
    identity,
    ws.configHome,
    () => Settings.load({ sources: [], projectTrusted: false }),
    vault,
    network,
  )!;
  const login = () =>
    account.signIn(
      {
        confirm: async () => true,
        authorize: async (address) => {
          const url = new URL(address),
            callback = new URL(url.searchParams.get("redirect_uri")!);
          callback.searchParams.set("state", url.searchParams.get("state")!);
          callback.searchParams.set("code", "fixture-code");
          return callback.href;
        },
      },
      new AbortController().signal,
    );
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=", ...args], {
      cwd: ws.project,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const repository = () => {
    git("init", "-q");
    ws.write("project/fixture.txt", "fixture");
    git("add", "fixture.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "Fixture",
    );
    git(
      "remote",
      "add",
      "origin",
      "https://forge.example.test/org/repository.git",
    );
  };
  return {
    ws,
    identity,
    vault,
    entries,
    network,
    sent,
    login,
    repository,
    git,
    handle: (value: typeof handler) => {
      handler = value;
    },
    extra: { credentialVault: vault, companyFetch: network },
  };
}
