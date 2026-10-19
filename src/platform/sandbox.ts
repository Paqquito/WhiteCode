// Implements: SPEC-PER-015 (verified confinement launch, private relay lifetime and explicit exit policy).
import { closeSync } from "node:fs";
import { sandboxContribution, sandboxMode } from "../permissions/sandbox";
import type { SandboxOptions } from "../permissions/sandbox";
import { sandboxLaunch, sandboxSocketPair, sandboxUnavailable } from "./sandbox-kernel";
import type { SandboxFiles, SandboxLaunch } from "./sandbox-kernel";
import { sandboxNetwork } from "./sandbox-network";
import type { SandboxNetworkPolicy } from "./sandbox-network";
import { productProcess } from "./product-process";
export interface SandboxProfile extends SandboxOptions { readonly files: SandboxFiles; readonly network: SandboxNetworkPolicy }
export class CommandSandbox {
  constructor(readonly profile: (cwd: string, allowed: readonly string[]) => SandboxProfile, readonly runtime?: string) {}
  mode(command: string, cwd: string, allowed: readonly string[], outside = false) { return sandboxMode(this.profile(cwd, allowed), command, outside); }
  contribution(command: string, cwd: string, allowed: readonly string[], outside = false) { return sandboxContribution(this.profile(cwd, allowed), command, outside); }
  refusal(command: string, cwd: string, allowed: readonly string[], outside = false): string | undefined {
    try {
      if (this.mode(command, cwd, allowed, outside) !== "confined") return undefined;
      return sandboxUnavailable() ?? (!this.runtime && productProcess([]).args.length ? "System sandbox requires an installed native executable; this source runtime is not verified." : undefined);
    } catch (error) { return (error as Error).message; }
  }
  launch(input: { command: string; file: string; args: readonly string[]; cwd: string; allowed: readonly string[]; environment: Readonly<Record<string, string>> }): SandboxLaunch {
    const unavailable = sandboxUnavailable(); if (unavailable) throw Error(unavailable);
    const profile = this.profile(input.cwd, input.allowed), process = productProcess([]), runtime = this.runtime ?? (process.args.length ? undefined : process.file);
    if (!runtime) throw Error("System sandbox requires an installed native executable; this source runtime is not verified.");
    const [host, guest] = sandboxSocketPair(); let guestOpen = true;
    const violations: string[] = [];
    const network = sandboxNetwork(host, { ...profile.network, violation(message) { if (violations.length < 16) violations.push(message); profile.network.violation(message); } });
    const closeGuest = () => { if (guestOpen) { guestOpen = false; closeSync(guest); } };
    try {
      const launch = sandboxLaunch({ files: profile.files, cwd: input.cwd, file: "/sandbox-runtime", args: ["--internal-sandbox-guest", input.cwd, input.file, ...input.args], environment: input.environment, channel: guest, runtime });
      return { ...launch, violations, spawned() { launch.spawned(); closeGuest(); }, close() { launch.close(); closeGuest(); network.close(); } };
    } catch (error) { closeGuest(); network.close(); throw error; }
  }
}
