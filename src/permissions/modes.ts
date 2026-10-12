// Implements: SPEC-PER-003 (§ 5.1 availability, § 5.2 initial mode, § 5.3 cycle, EF-01, EF-02, EF-04, ERR-01, ERR-02, CA-01, CA-03, CA-05, CA-06), SPEC-MOD-002 (EF-02), SPEC-MOD-011 (EF-07)

import { PERMISSION_MODES, type PermissionMode } from "../config/settings-schema";
import { buildFlag } from "../extension-points/build-flags";

export interface ModeAvailability {
  readonly allowUnrestrictedOption: boolean;
  readonly disableUnrestricted: boolean;
  readonly disableAutoApprove: boolean;
  /** Consent valid for the current version (SPEC-PER-018). */
  readonly autoApproveConsent: boolean;
}

export class ModeError extends Error {}

export function isModeAvailable(mode: PermissionMode, a: ModeAvailability): boolean {
  switch (mode) {
    case "unrestricted":
      return a.allowUnrestrictedOption && !a.disableUnrestricted;
    case "auto_approve":
      return buildFlag("permission_auto_approve") && a.autoApproveConsent && !a.disableAutoApprove;
    default:
      return true;
  }
}

export function unavailableReason(mode: PermissionMode, a: ModeAvailability): string {
  if (mode === "unrestricted" && a.disableUnrestricted) return "Ce mode est désactivé par votre administrateur.";
  if (mode === "unrestricted") return "Le mode unrestricted n'est accessible qu'avec l'option --allow-unrestricted-mode.";
  if (mode === "auto_approve" && a.disableAutoApprove) return "Ce mode est désactivé par votre administrateur.";
  if (mode === "auto_approve" && buildFlag("permission_auto_approve") && !a.autoApproveConsent) return "Le consentement à l'approbation automatique est absent ou périmé.";
  return "Le mode d'approbation automatique n'est pas disponible dans cette version.";
}

/**
 * Initial mode: `--approval-mode`, otherwise the configured mode (interactive: `permissions.initialMode`;
 * non-interactive: `engine.nonInteractive.defaultPermissionMode`), otherwise the safe default.
 * A mode requested on the command line and unavailable stops the launch; a configured one falls back with a warning.
 */
export function resolveInitialMode(
  cliMode: string | undefined,
  configured: PermissionMode,
  nonInteractive: boolean,
  availability: ModeAvailability,
  warn: (message: string) => void,
): PermissionMode {
  const safe: PermissionMode = nonInteractive ? "no_prompt" : "ask";
  if (cliMode !== undefined) {
    if (!(PERMISSION_MODES as readonly string[]).includes(cliMode)) throw new ModeError(`Mode de permission inconnu : ${cliMode}.`);
    const mode = cliMode as PermissionMode;
    if (!isModeAvailable(mode, availability)) throw new ModeError(unavailableReason(mode, availability));
    return mode;
  }
  if (!isModeAvailable(configured, availability)) {
    warn(`${unavailableReason(configured, availability)} Mode ${safe} appliqué.`);
    return safe;
  }
  return configured;
}

/** Cycle order of § 5.3: ask → auto_edit → planning → auto_approve (if available) → unrestricted (if allowed) → ask. */
export function nextMode(current: PermissionMode, a: ModeAvailability): PermissionMode {
  const order: PermissionMode[] = ["ask", "auto_edit", "planning", "auto_approve", "unrestricted"];
  const index = order.indexOf(current);
  for (let i = 1; i <= order.length; i++) {
    const candidate = order[(Math.max(index, 0) + i) % order.length]!;
    if (isModeAvailable(candidate, a)) return candidate;
  }
  return "ask";
}

/** Reminder given to the model after a mode change (CA-06), in the language of the texts for the model. */
const MODE_NOTES: Readonly<Record<PermissionMode, string>> = {
  ask: "The permission mode is now ask: actions that need a permission are confirmed by the user before they run.",
  planning: "The permission mode is now planning: explore and prepare a plan; do not modify files or change anything until the plan is approved.",
  auto_edit: "The permission mode is now auto_edit: file edits inside the working folders are applied without confirmation; other actions still need a permission.",
  no_prompt: "The permission mode is now no_prompt: actions without a prior permission are denied, since nobody can be asked.",
  auto_approve: "The permission mode is now auto_approve: an automatic reviewer approves or blocks actions that need a permission.",
  unrestricted: "The permission mode is now unrestricted: actions run without confirmation, except those the policy always confirms.",
};

/** Current mode of a session; a change is announced to the model before its next request (CA-06). */
export class ModeState {
  #mode: PermissionMode;
  #pendingNote: string | undefined;

  constructor(
    initial: PermissionMode,
    private readonly availability: ModeAvailability,
  ) {
    this.#mode = initial;
  }

  get mode(): PermissionMode {
    return this.#mode;
  }

  /** Changes the mode; an unavailable mode is refused (ERR-01). */
  set(mode: PermissionMode): void {
    if (!isModeAvailable(mode, this.availability)) throw new ModeError(unavailableReason(mode, this.availability));
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#pendingNote = MODE_NOTES[mode];
  }

  /** Cycle of § 5.3; returns the new mode. */
  cycle(): PermissionMode {
    this.set(nextMode(this.#mode, this.availability));
    return this.#mode;
  }

  /** Reminder to append before the next request, once. */
  takeNote(): string | undefined {
    const note = this.#pendingNote;
    this.#pendingNote = undefined;
    return note;
  }
}
