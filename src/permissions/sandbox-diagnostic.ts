// Implements: SPEC-CMD-062 (CA-01, honest dependency status and installation guidance), gap E-170.
import type { PlatformName } from "../platform/system";
export function sandboxDiagnostic(platform: PlatformName, find: (name: string) => string | undefined): string {
  if (platform !== "linux") return "Moteur d’isolation système indisponible : seul le moteur Linux x64 natif a été éprouvé. Les commandes confinées sont refusées sur cette plateforme ; les permissions ordinaires restent appliquées aux sorties explicitement autorisées.";
  if (!find("bwrap")) return "Dépendance d’isolation absente : bubblewrap (bwrap). Instructions d’installation : installer bubblewrap avec le gestionnaire de paquets de la distribution. Aucune commande confinée ne sera exécutée avant sa disponibilité.";
  return "Bubblewrap détecté. Le moteur Linux x64 natif utilise des espaces de noms fichiers, processus et réseau, un filtre système et un relais de domaines borné. Le lancement exige un exécutable natif, glibc et les espaces de noms utilisateur activés ; toute indisponibilité refuse la commande sans exécution de repli. Ce diagnostic ne vérifie pas les capacités du noyau.";
}
