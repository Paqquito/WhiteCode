// Implements: SPEC-INT-021, SPEC-CMD-071 (confirmed JSONC configuration, verified backup, idempotence and rollback).
// Supports: SPEC-IHM-007, gap E-174.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { currentPlatform, type PlatformName } from "../platform/system";
import { writeAtomic } from "../tools/text-file";
export const NEWLINE_SEQUENCE = "\u001b[13;2u";
export interface TerminalTarget { readonly name: string; readonly path: string; readonly kind: "editor" | "windows-terminal" }
export interface TerminalPlan extends TerminalTarget { readonly original: string; readonly next: string; readonly existed: boolean }
export function detectTerminal(o: { home: string; platform: PlatformName; variable: (name: string) => string | undefined }): TerminalTarget | undefined {
  if (o.variable("TERM_PROGRAM") === "vscode") {
    const directory = o.platform === "windows" ? join(o.variable("APPDATA") ?? join(o.home, "AppData", "Roaming"), "Code", "User") : o.platform === "macos" ? join(o.home, "Library", "Application Support", "Code", "User") : join(o.variable("XDG_CONFIG_HOME") ?? join(o.home, ".config"), "Code", "User");
    return { name: "Terminal intégré de VS Code", path: join(directory, "keybindings.json"), kind: "editor" };
  }
  if (o.platform === "windows" && o.variable("WT_SESSION")) {
    const local = o.variable("LOCALAPPDATA") ?? join(o.home, "AppData", "Local");
    const candidates = [join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"), join(local, "Microsoft", "Windows Terminal", "settings.json")];
    const path = candidates.find(path => existsSync(path)); if (path) return { name: "Terminal Windows", path, kind: "windows-terminal" };
  }
  return undefined;
}
function decoded(text: string): unknown { const errors: ParseError[] = []; const value: unknown = parse(text, errors, { allowTrailingComma: true }); if (errors.length) throw new Error("Configuration du terminal illisible : JSONC invalide."); return value; }
export function terminalPlan(target: TerminalTarget): TerminalPlan {
  ordinaryPrivateFile(target.path, 1024 * 1024); const existed = existsSync(target.path), original = existed ? readPrivateText(target.path, 1024 * 1024) : "", source = original.trim() ? original : target.kind === "editor" ? "[]\n" : "{}\n";
  const value = decoded(source), format = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes("\r\n") ? "\r\n" : "\n" } };
  let next = source;
  if (target.kind === "editor") {
    if (!Array.isArray(value)) throw new Error("La configuration des raccourcis doit être une liste.");
    const index = value.findIndex(entry => entry?.key === "shift+enter" && entry?.when === "terminalFocus"), binding = { key: "shift+enter", command: "workbench.action.terminal.sendSequence", args: { text: NEWLINE_SEQUENCE }, when: "terminalFocus" };
    if (index >= 0 && JSON.stringify(value[index]) === JSON.stringify(binding)) return { ...target, original, next: original, existed };
    next = applyEdits(source, modify(source, [index >= 0 ? index : value.length], binding, { ...format, isArrayInsertion: index < 0 }));
  } else {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La configuration du terminal doit être un objet.");
    const actions = (value as { actions?: unknown }).actions; if (actions !== undefined && !Array.isArray(actions)) throw new Error("La liste d’actions est invalide.");
    const list = actions ?? [], index = list.findIndex((entry: { keys?: unknown }) => entry?.keys === "shift+enter"), binding = { keys: "shift+enter", command: { action: "sendInput", input: NEWLINE_SEQUENCE } };
    if (index >= 0 && JSON.stringify(list[index]) === JSON.stringify(binding)) return { ...target, original, next: original, existed };
    if (actions === undefined) next = applyEdits(next, modify(next, ["actions"], [], format));
    next = applyEdits(next, modify(next, ["actions", index >= 0 ? index : list.length], binding, { ...format, isArrayInsertion: index < 0 }));
  }
  decoded(next); return { ...target, original, next, existed };
}
export function applyTerminalPlan(plan: TerminalPlan, fault?: () => void): string | undefined {
  ordinaryPrivateFile(plan.path, 1024 * 1024);
  if (existsSync(plan.path) !== plan.existed || plan.existed && readPrivateText(plan.path, 1024 * 1024) !== plan.original) throw new Error("Configuration modifiée depuis la proposition ; recommencez.");
  if (plan.original === plan.next) return undefined;
  mkdirSync(dirname(plan.path), { recursive: true, mode: 0o700 }); ordinaryPrivateFile(plan.path, 1024 * 1024);
  const backup = `${plan.path}.backup-${Date.now()}-${randomUUID()}`; ordinaryPrivateFile(backup, 1024 * 1024);
  writeAtomic(backup, Buffer.from(plan.original), currentPlatform(), true);
  if (readPrivateText(backup, 1024 * 1024) !== plan.original) throw new Error("Sauvegarde non vérifiée ; configuration conservée.");
  try { writeAtomic(plan.path, Buffer.from(plan.next), currentPlatform(), true); fault?.(); if (readPrivateText(plan.path, 1024 * 1024) !== plan.next) throw new Error("Configuration non vérifiée."); decoded(plan.next); }
  catch (error) { if (plan.existed) writeAtomic(plan.path, Buffer.from(plan.original), currentPlatform(), true); else if (existsSync(plan.path)) { ordinaryPrivateFile(plan.path, 1024 * 1024); unlinkSync(plan.path); } throw error; }
  return backup;
}
export function restoreTerminal(target: TerminalTarget, backup: string): void {
  if (!backup.startsWith(target.path + ".backup-") || !/^[0-9]+-[a-f0-9-]{36}$/.test(backup.slice((target.path + ".backup-").length))) throw new Error("Sauvegarde étrangère à ce terminal.");
  ordinaryPrivateFile(target.path, 1024 * 1024); const text = readPrivateText(backup, 1024 * 1024); if (text.trim()) decoded(text); writeAtomic(target.path, Buffer.from(text), currentPlatform(), true);
}
