// Implements: SPEC-CMD-062 (CA-01, honest dependency status and installation guidance), gap E-170.
import type { PlatformName } from "../platform/system";
export function sandboxDiagnostic(platform: PlatformName, find: (name: string) => string | undefined): string {
  if (platform === "windows" || platform === "other") return "Isolation système indisponible sur cette plateforme. Pour installer les dépendances d’isolation, utilisez un environnement Linux puis installez bubblewrap (bwrap) et socat avec le gestionnaire de paquets de cet environnement. Les permissions ordinaires restent appliquées.";
  const dependencies = platform === "linux" ? ["bwrap", "socat"] : ["sandbox-exec"];
  const missing = dependencies.filter(name => !find(name));
  return missing.length ? `Dépendances d’isolation absentes : ${missing.join(", ")}. Instructions d’installation : ${platform === "linux" ? "installer bubblewrap et socat avec le gestionnaire de paquets de la distribution" : "rétablir sandbox-exec avec les outils système"}.` : "Dépendances détectées. Le moteur d’isolation système n’est pas encore disponible ; les permissions ordinaires restent appliquées.";
}
