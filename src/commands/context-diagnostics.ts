// Implements: SPEC-CMD-087 (CA-01, EF-01/02, RG-01), SPEC-CMD-089 (CA-01, EF-01, RG-01), gap E-150.
import { buildFlag, buildProfile } from "../extension-points/build-flags" with { type: "macro" };
import { OWN_VARIABLES, PUBLIC_SECRET_VARIABLES, type EnvironmentView } from "../config/environment";
import type { Conversation } from "../engine/conversation";
import { maskSecrets } from "../shared/secrets";

export function environmentReport(env: EnvironmentView, prefix: string): string {
  if (!buildFlag("diagnostics_environment_inspection") || buildProfile() !== "internal") throw Error("Inspection de l’environnement indisponible dans ce profil.");
  const lines: string[] = [];
  for (const definition of OWN_VARIABLES) {
    const value = env.own(definition.name);
    if (value === undefined) continue;
    const safe = definition.secret || /KEY|TOKEN|PASSWORD|SECRET/.test(definition.name) ? "••••" : maskSecrets(value);
    lines.push(`${prefix}${definition.name} = ${safe} — ${definition.setting ?? definition.owner}`);
  }
  for (const name of PUBLIC_SECRET_VARIABLES) if (env.public(name) !== undefined) lines.push(`${name} = •••• — identifiant d'API`);
  return lines.length ? lines.join("\n") : "Aucune variable du catalogue définie.";
}

export function contextReport(conversation: Conversation): string {
  if (!buildFlag("diagnostics_context_inspection") || buildProfile() !== "internal") throw Error("Inspection du contexte indisponible dans ce profil.");
  const lines = ["Blocs de la requête (lecture seule, aucune requête envoyée) :"];
  const add = (name: string, content: string) => lines.push(`${maskSecrets(name)} — ${Buffer.byteLength(content, "utf8")} octets ; environ ${Math.ceil(content.length / 3.5)} jetons`);
  conversation.system.forEach((block, n) => add(`Instructions système ${n + 1}`, block.text));
  conversation.tools.forEach(tool => add(`Outil ${tool.name}`, JSON.stringify(tool)));
  conversation.messages.forEach((message, n) => {
    if (message.role !== "user") { add(`Message ${n + 1} (${message.role})`, JSON.stringify(message)); return; }
    message.parts.forEach((part, index) => {
      const content = part.type === "text" ? part.text : JSON.stringify(part);
      const attachment = part.type === "text" ? /<attached-file\s+path="([^"]*)"/.exec(part.text)?.[1] : part.type === "image" ? `image ${index + 1}` : undefined;
      add(attachment ? `Pièce jointe : ${attachment}` : `Message ${n + 1}, bloc ${index + 1} (${part.type})`, content);
    });
  });
  return lines.join("\n");
}
