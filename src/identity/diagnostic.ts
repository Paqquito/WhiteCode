// Supports: SPEC-CAD-002 (CA-12, CA-14: override sources and rejected branding), gap E-133.
import type { Identity } from "./identity";
import type { Finding } from "../admin/diagnostic";
export function identityFindings(identity: Identity): Finding[] {
  return [
    ...identity.overrides.map((o): Finding => ({ status: "ok", area: "Identité", message: `${o.name} : ${o.source === "environment" ? "variable d'environnement" : "paramètre géré"}` })),
    ...identity.warnings.map((w): Finding => ({ status: "warning", area: "Identité", message: `[${w.code}] ${w.message}` })),
  ];
}
