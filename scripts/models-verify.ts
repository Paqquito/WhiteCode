// Supports: SPEC-API-006 (catalogue entries checked against the providers), gap E-010 (limits verified by the Models API during development)
// Checks the catalogue of the distribution (and the local catalogue) against the Models API of each provider, with the official SDKs.
// Credentials come from the environment only (never from the repository): ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL.
// Usage: bun scripts/models-verify.ts [--catalog identity/dev.models.json] [--provider anthropic|openai|openai_compatible] [--extra <settings.json>]

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Entry {
  readonly id: string;
  readonly provider: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const root = resolve(import.meta.dir, "..");
const catalog = JSON.parse(readFileSync(resolve(arg("catalog") ?? `${root}/identity/dev.models.json`), "utf8")) as { models: Entry[] };
const extra = arg("extra") ? ((JSON.parse(readFileSync(resolve(arg("extra")!), "utf8")) as { models?: { extraCatalog?: Entry[] } }).models?.extraCatalog ?? []) : [];
const only = arg("provider");
const entries = [...catalog.models, ...extra].filter((e) => !only || e.provider === only);
if (entries.length === 0) {
  console.log("No catalogue entry to verify.");
  process.exit(0);
}

let problems = 0;
const report = (ok: boolean, text: string) => {
  if (!ok) problems++;
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
};

for (const provider of [...new Set(entries.map((e) => e.provider))]) {
  const wanted = entries.filter((e) => e.provider === provider);
  try {
    if (provider === "anthropic") {
      if (!process.env["ANTHROPIC_API_KEY"]) throw new Error("ANTHROPIC_API_KEY is not set");
      const client = new Anthropic({ baseURL: process.env["ANTHROPIC_BASE_URL"] || undefined });
      for (const e of wanted) {
        try {
          const info = await client.models.retrieve(e.id);
          report(true, `${provider} ${e.id}: known (${info.display_name})`);
          if (info.max_input_tokens != null) report(info.max_input_tokens >= e.contextWindow, `${provider} ${e.id}: context window ${e.contextWindow} ≤ ${info.max_input_tokens}`);
          if (info.max_tokens != null) report(info.max_tokens >= e.maxOutputTokens, `${provider} ${e.id}: output limit ${e.maxOutputTokens} ≤ ${info.max_tokens}`);
        } catch (error) {
          report(false, `${provider} ${e.id}: ${(error as Error).message}`);
        }
      }
    } else if (provider === "openai" || provider === "openai_compatible") {
      const baseURL = process.env["OPENAI_BASE_URL"];
      if (provider === "openai_compatible" && !baseURL) throw new Error("OPENAI_BASE_URL is not set");
      if (provider === "openai" && !process.env["OPENAI_API_KEY"]) throw new Error("OPENAI_API_KEY is not set");
      const client = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] ?? "unused", ...(baseURL ? { baseURL } : {}) });
      const available = new Set<string>();
      for await (const model of client.models.list()) available.add(model.id);
      // This API gives no limits: only the existence of each identifier is checked.
      for (const e of wanted) report(available.has(e.id), `${provider} ${e.id}: ${available.has(e.id) ? "known" : "not listed by the server"}`);
    } else {
      console.log(`skip ${provider}: no adapter in this version`);
    }
  } catch (error) {
    report(false, `${provider}: ${(error as Error).message}`);
  }
}
console.log(problems === 0 ? "\nCatalogue verified." : `\n${problems} problem(s).`);
process.exit(problems === 0 ? 0 : 1);
