// Implements: SPEC-CFG-011 (managed-only source supplied by Settings, one bounded local notice).
// Supports: SPEC-IHM-025, E-159.
import { sanitize } from "../ui/text";
export function announcement(messages: readonly string[], random = Math.random): string | undefined {
  const choices = messages.slice(0, 20).filter(message => message.trim()); if (!choices.length) return;
  const selected = choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))]!;
  return `Message de votre organisation : ${sanitize(selected.slice(0, 500) + (selected.length > 500 ? "…" : ""))}`;
}
