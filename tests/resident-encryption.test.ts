// Supports: SPEC-MOD-022 (private registry across restart and real administration).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  ResidentSupervisor,
  readResidentEndpoint,
} from "../src/services/supervisor";
import { residentRequest } from "../src/services/transport";
import {
  privateStorageScope,
  openPrivateStorage,
} from "../src/session/private-storage";
import type { CredentialVault } from "../src/platform/credential-vault";
import { workspace, loadIdentity, cli } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
test("SPEC-MOD-022/CA-03 — encrypted summaries survive restart and the actual list command reads them without a plaintext registry", async () => {
  const ws = workspace(),
    identity = loadIdentity(),
    entries = new Map<string, string>();
  const vault: CredentialVault = {
    read: (service, key) => entries.get(service + key),
    write: (service, key, value) => {
      entries.set(service + key, value);
    },
    remove: (service, key) => {
      entries.delete(service + key);
    },
  };
  const script = ws.write(
      "worker.ts",
      'console.log(JSON.stringify({type:"session"}));for await(const _ of console){}',
    ),
    witness = "private-summary-" + crypto.randomUUID();
  await privateStorageScope(async () => {
    const release = await openPrivateStorage({
      root: ws.configHome,
      service: identity.get("PRODUCT_SLUG") + ":archives",
      vault,
      enabled: true,
    });
    const create = () =>
      new ResidentSupervisor({
        root: ws.configHome,
        maxConcurrent: 4,
        waitMs: 1000,
        assertPolicy: () => {},
        environment: () => productEnv(ws),
        program: () => ({ file: process.execPath, args: [script] }),
        wasAccepted: () => false,
        history: () => [],
        notify: async () => {},
      });
    let service = create();
    try {
      await service.start();
      await residentRequest(
        readResidentEndpoint(ws.configHome)!,
        "/workers",
        { kind: "assistant", cwd: ws.project, prompt: witness },
        AbortSignal.timeout(2000),
      );
      await service.close();
      service = create();
      await service.start();
      const result = await cli(["background-session", "list", "--json"], ws, {
        userConfig: { storage: { encryption: { enabled: true } } },
        extra: { credentialVault: vault },
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).workers).toContainEqual(
        expect.objectContaining({ summary: witness }),
      );
      expect(
        existsSync(join(ws.configHome, "background-sessions", "registry.json")),
      ).toBe(false);
      await service.close();
      const scan = (directory: string): void => {
        for (const item of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, item.name);
          if (item.isDirectory()) scan(path);
          else
            expect(readFileSync(path).includes(Buffer.from(witness))).toBe(
              false,
            );
        }
      };
      scan(ws.configHome);
    } finally {
      await service.close();
      release();
    }
  });
}, 20000);
