// Implements: SPEC-API-001 (§ 5.1 providers delivered, FA-01, EF-02 capability matrix of each adapter, EF-04 documented degradation)
// Supports: decisions D-09 to D-11 (no default provider, reference provider, optional adapter), gap E-065

import type { ModelCapabilities } from "./catalog";

/** Providers whose adapter is delivered in this version. */
export const PROVIDERS_DELIVERED = ["openai_compatible", "openai", "anthropic", "bedrock"] as const;
export type DeliveredProvider = (typeof PROVIDERS_DELIVERED)[number];

/** What an adapter can carry to its protocol; a model capability it cannot carry is degraded (EF-02). */
export interface AdapterMatrix {
  readonly thinking: boolean;
  readonly thinkingBudget: boolean;
  readonly effort: boolean;
  readonly images: boolean;
  readonly pdf: boolean;
  readonly filesApi: boolean;
  readonly toolInputStreaming: boolean;
  readonly forcedToolChoice: boolean;
  readonly contextEditing: boolean;
  readonly cacheEditing: boolean;
  readonly serverCompaction: boolean;
  readonly systemMessages: boolean;
}

export const ADAPTER_MATRIX: Readonly<Record<DeliveredProvider, AdapterMatrix>> = {
  // Chat protocol: thinking and effort only through the switches declared in `providerOptions` (gap E-043).
  openai_compatible: { thinking: true, thinkingBudget: false, effort: true, images: true, pdf: false, filesApi: false, toolInputStreaming: false, forcedToolChoice: true, contextEditing: false, cacheEditing: true, serverCompaction: false, systemMessages: true },
  openai: { thinking: true, thinkingBudget: false, effort: true, images: true, pdf: false, filesApi: false, toolInputStreaming: false, forcedToolChoice: true, contextEditing: false, cacheEditing: false, serverCompaction: false, systemMessages: true },
  anthropic: { thinking: true, thinkingBudget: true, effort: true, images: true, pdf: true, filesApi: true, toolInputStreaming: true, forcedToolChoice: true, contextEditing: true, cacheEditing: false, serverCompaction: false, systemMessages: true },
  bedrock: { thinking: false, thinkingBudget: false, effort: false, images: true, pdf: true, filesApi: false, toolInputStreaming: false, forcedToolChoice: false, contextEditing: false, cacheEditing: false, serverCompaction: false, systemMessages: false },
};

/** Documented effect of each degradation (EF-04: never an opaque error). */
const DEGRADATIONS: Readonly<Record<keyof AdapterMatrix, string>> = {
  thinking: "pas de réflexion : aucune réflexion n'est demandée ni affichée",
  thinkingBudget: "pas de budget de réflexion : réflexion adaptative",
  effort: "pas de niveau d'effort : le paramètre n'est pas transmis",
  images: "pas d'image : les images sont remplacées par une mention",
  pdf: "pas de PDF : les documents sont refusés",
  filesApi: "pas d'API de fichiers : les documents acceptés sont transmis en ligne",
  toolInputStreaming: "pas de diffusion des paramètres d'outil : ils arrivent en fin d'appel",
  forcedToolChoice: "pas de choix d'outil imposé",
  contextEditing: "pas d'effacement côté service : micro-compaction locale ou compaction complète",
  cacheEditing: "pas d’édition ciblée du cache : micro-compaction ordinaire",
  serverCompaction: "pas de compaction côté service : compaction par le produit",
  systemMessages: "pas de message système intermédiaire : les rappels sont joints au message suivant",
};

export function isDeliveredProvider(id: string): id is DeliveredProvider {
  return (PROVIDERS_DELIVERED as readonly string[]).includes(id);
}

/** Capabilities of the model restricted to what the adapter carries, with the degradations applied (FA-01). */
export function effectiveCapabilities(caps: ModelCapabilities, provider: DeliveredProvider): { capabilities: ModelCapabilities; degradations: string[] } {
  const m = ADAPTER_MATRIX[provider];
  const degradations: string[] = [];
  const keep = <K extends keyof AdapterMatrix>(key: K, declared: boolean) => {
    if (declared && !m[key]) degradations.push(DEGRADATIONS[key]);
    return declared && m[key];
  };
  const thinkingKept = keep("thinking", caps.thinking !== "none");
  const capabilities: ModelCapabilities = {
    ...caps,
    thinking: thinkingKept ? caps.thinking : "none",
    thinkingBudget: keep("thinkingBudget", caps.thinkingBudget),
    effort: keep("effort", caps.effort.length > 0) ? caps.effort : [],
    images: keep("images", caps.images),
    pdf: keep("pdf", caps.pdf),
    filesApi: keep("filesApi", caps.filesApi === true),
    toolInputStreaming: keep("toolInputStreaming", caps.toolInputStreaming),
    forcedToolChoice: keep("forcedToolChoice", caps.forcedToolChoice),
    contextEditing: keep("contextEditing", caps.contextEditing),
    cacheEditing: keep("cacheEditing", caps.cacheEditing === true),
    serverCompaction: keep("serverCompaction", caps.serverCompaction),
    systemMessages: keep("systemMessages", caps.systemMessages),
  };
  return { capabilities, degradations };
}
