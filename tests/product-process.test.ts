import { expect, test } from "bun:test";
import { join } from "node:path";
import { productProcess } from "../src/platform/product-process";
import { runToCompletion } from "../src/platform/process";
import { workspace } from "./helpers/env";

test("TECH — source product launch disables runtime automatic environment files", () => {
  const ws = workspace(); ws.write("project/.env", "PRODUCT_PROCESS_DOTENV_WITNESS=fixture-not-a-secret\n");
  const probe = ws.write("probe.ts", 'console.log(process.env["PRODUCT_PROCESS_DOTENV_WITNESS"] ?? "absent");');
  const launch = productProcess(["--version"]); expect(launch.args[0]).toBe("--no-env-file");
  const result = runToCompletion(launch.file, [launch.args[0]!, probe], { cwd: ws.project, env: {}, timeoutMs: 10000 });
  expect(result.code).toBe(0); expect(result.stdout.trim()).toBe("absent");
});
