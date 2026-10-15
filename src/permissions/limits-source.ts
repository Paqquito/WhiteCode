// Supports: SPEC-PER-020, SPEC-CFG-003 (independent mandatory authority and account-bound cache); gap E-183.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { visit } from "jsonc-parser";
import { readPolicySource } from "../config/protected-policy-source";
import { readPrivateText, ordinaryPrivateFile } from "../shared/private-text";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";
import type { PolicyFileProtectionReader } from "../platform/policy-file";
import type { LimitsAuthority, LimitsVersion } from "./organization-limits";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function strict(text: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(text),
    stack: Set<string>[] = [];
  let duplicate = false;
  visit(text, {
    onObjectBegin: () => {
      stack.push(new Set());
    },
    onObjectEnd: () => {
      stack.pop();
    },
    onObjectProperty: (key) => {
      const keys = stack.at(-1)!;
      if (
        keys.has(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        duplicate = true;
      keys.add(key);
    },
  });
  if (!object(raw) || duplicate) throw Error("Objet JSON strict attendu.");
  return raw;
}
export function limitsSource(o: {
  managedDir: string;
  configDir: string;
  organizationId?: string;
  protection?: PolicyFileProtectionReader;
  now?: () => number;
  report: (text: string) => void;
}) {
  const authorizationFile = join(o.managedDir, "limits-source.json"),
    cacheFile = join(o.configDir, "organization-limits-cache.json");
  let lastIssue = "";
  const report = (text: string) => {
    if (text !== lastIssue) {
      lastIssue = text;
      o.report(text);
    }
  };
  const authority = (): LimitsAuthority => {
    const source = readPolicySource(authorizationFile, undefined, o.protection);
    if (!source.issue && source.text === undefined)
      return { required: false, perimeter: "all" };
    const blocked = (reason: string): LimitsAuthority => {
      report("Source obligatoire des limites invalide : " + reason);
      return { required: true, perimeter: "all", authorizedCache: () => false };
    };
    if (source.issue || source.protection?.writable !== false)
      return blocked("autorité administrateur absente ou invérifiable.");
    try {
      const raw = strict(source.text!),
        now = (o.now ?? Date.now)();
      if (
        Object.keys(raw).some(
          (key) =>
            ![
              "schemaVersion",
              "organizationId",
              "required",
              "perimeter",
              "offline",
            ].includes(key),
        ) ||
        raw.schemaVersion !== 1 ||
        raw.required !== true ||
        typeof raw.organizationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(raw.organizationId) ||
        (o.organizationId !== undefined &&
          raw.organizationId !== o.organizationId) ||
        !["all", "remote"].includes(String(raw.perimeter))
      )
        return blocked("déclaration indépendante invalide.");
      const organizationId = raw.organizationId,
        perimeter = raw.perimeter as "all" | "remote",
        offline = raw.offline;
      if (
        offline !== undefined &&
        (!object(offline) ||
          Object.keys(offline).some(
            (key) => !["sha256", "validUntil"].includes(key),
          ) ||
          typeof offline.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(offline.sha256) ||
          typeof offline.validUntil !== "number" ||
          !Number.isFinite(offline.validUntil))
      )
        return blocked("autorisation hors ligne invalide.");
      return {
        required: true,
        perimeter,
        organizationId,
        authorityId: createHash("sha256").update(source.text!).digest("hex"),
        authorizedCache: (version) =>
          object(offline) &&
          version.organizationId === organizationId &&
          Number(offline.validUntil) > now &&
          version.validUntil > now &&
          createHash("sha256").update(JSON.stringify(version)).digest("hex") ===
            offline.sha256,
      };
    } catch {
      return blocked("lecture ou syntaxe invalide.");
    }
  };
  return {
    authorizationFile,
    cacheFile,
    authority,
    readCache: (): unknown => {
      ordinaryPrivateFile(cacheFile, 65536);
      return strict(readPrivateText(cacheFile, 65536));
    },
    writeCache: (value: LimitsVersion, account: string) => {
      ordinaryPrivateFile(cacheFile, 65536);
      writeAtomic(
        cacheFile,
        Buffer.from(JSON.stringify({ account, value })),
        currentPlatform(),
        true,
      );
    },
  };
}
