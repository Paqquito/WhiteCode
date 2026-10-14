import { expect, test } from "bun:test";
import { CredentialHelper, credentialHelperProvider } from "../src/auth/credential-helper";
import { ProviderError, type ModelEvent } from "../src/providers/types";

test("TECH — credential redaction retains partial text when a provider fails or is interrupted", async () => {
  const key = "fixture-long-credential-1234567890";
  const helper = new CredentialHelper({
    command: `"${process.execPath.replace(/\\/g, "/")}" -e "console.log('${key}')"`,
    cwd: process.cwd(),
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ttlMs: () => 10_000,
    remember: () => {},
    diagnostic: () => {},
  });
  try {
    for (const kind of ["connection", "aborted", "authentication"] as const) {
      const signal = new AbortController().signal;
      let requests = 0;
      const provider = credentialHelperProvider(helper, () => ({
        id: "fixture",
        async *stream() {
          requests++;
          yield { type: "text_delta" as const, text: "Partial useful answer" };
          throw new ProviderError(kind, "stream interrupted");
        },
      }), key, value => value.replaceAll(key, "[redacted credential]"), () => [key]);
      const events: ModelEvent[] = [];
      const collect = async () => { for await (const event of provider.stream({} as never, signal)) events.push(event); };
      await expect(collect()).rejects.toBeInstanceOf(ProviderError);
      expect(events).toEqual([{ type: "text_delta", text: "Partial useful answer" }]);
      expect(requests).toBe(1);
    }
  } finally { await helper.close(); }
});
