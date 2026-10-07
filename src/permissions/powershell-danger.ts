// Implements: SPEC-OUT-009 (EF-04 analysis of dangerous cmdlets before execution, RG-01, CA-03)
// Supports: SPEC-PER-009 (out of lot: minimal subset for PowerShell only), gap E-052

import { splitCommand } from "./command-split";

/** Cmdlets (and their usual aliases) that delete, stop processes, or change the registry or security settings (RG-01). */
const DANGEROUS = new Set(
  [
    "remove-item", "ri", "rm", "rmdir", "rd", "del", "erase",
    "remove-itemproperty", "rp", "clear-content", "clc", "clear-item", "cli", "clear-itemproperty", "clp",
    "stop-process", "kill", "spps", "stop-service", "spsv", "remove-service", "stop-computer", "restart-computer",
    "set-executionpolicy", "set-acl", "set-mppreference", "add-mppreference", "remove-mppreference", "disable-computerrestore",
    "format-volume", "clear-disk", "remove-partition", "initialize-disk", "remove-localuser", "remove-localgroupmember",
    "invoke-expression", "iex",
  ],
);

/** Cmdlets dangerous only on the registry. */
const REGISTRY_WRITERS = new Set(["set-itemproperty", "sp", "new-itemproperty", "set-item", "si", "new-item", "ni", "move-item", "mi", "rename-item", "rni"]);

function firstWord(part: string): string {
  return part.replace(/^[&.]\s*/, "").trim().split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "").toLowerCase() ?? "";
}

/** Reason for an unconditional confirmation, or undefined. */
export function dangerousPowerShell(command: string): string | undefined {
  const split = splitCommand(command, "powershell");
  for (const part of [...split.parts, ...split.nested]) {
    const word = firstWord(part);
    if (DANGEROUS.has(word)) return `The command uses ${word}, which always requires a confirmation.`;
    if (REGISTRY_WRITERS.has(word) && /\b(HKLM|HKCU|HKCR|HKU|HKCC|Registry)::?/i.test(part)) return `The command modifies the registry with ${word}, which always requires a confirmation.`;
  }
  return undefined;
}
