// Implements: SPEC-PER-020 (restrictive limits, conditional refresh and independent offline authority), gap E-183.
export const ORGANIZATION_LIMITS = [
  "remote_sessions",
  "unrestricted_mode",
  "auto_approve_mode",
] as const;
export type OrganizationLimit = (typeof ORGANIZATION_LIMITS)[number];
export interface LimitsVersion {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly version: string;
  readonly validUntil: number;
  readonly limits: readonly string[];
}
export interface LimitsAuthority {
  readonly required: boolean;
  readonly organizationId?: string;
  readonly authorityId?: string;
  readonly perimeter: "all" | "remote";
  readonly authorizedCache?: (version: LimitsVersion) => boolean;
}
interface Options {
  readonly owner: () => { account: string; organizationId: string } | undefined;
  readonly authority: () => LimitsAuthority;
  readonly readCache: () => unknown;
  readonly writeCache: (version: LimitsVersion, account: string) => void;
  readonly load: (
    knownVersion: string | undefined,
    signal: AbortSignal,
    owner: { account: string; organizationId: string },
  ) => Promise<unknown>;
  readonly report: (text: string) => void;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function parsed(
  value: unknown,
  organization: string,
  now: number,
): LimitsVersion | undefined {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "schemaVersion",
          "organizationId",
          "version",
          "validUntil",
          "limits",
        ].includes(key),
    ) ||
    value["schemaVersion"] !== 1 ||
    value["organizationId"] !== organization ||
    typeof value["version"] !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(value["version"]) ||
    typeof value["validUntil"] !== "number" ||
    !Number.isFinite(value["validUntil"]) ||
    value["validUntil"] <= now ||
    value["validUntil"] > now + 30 * 86400000 ||
    !Array.isArray(value["limits"]) ||
    value["limits"].length > 32 ||
    value["limits"].some(
      (limit) => typeof limit !== "string" || !/^[a-z_]{1,64}$/.test(limit),
    ) ||
    new Set(value["limits"]).size !== value["limits"].length
  )
    return undefined;
  return value as unknown as LimitsVersion;
}
export class OrganizationLimits {
  #active?: LimitsVersion;
  #owner?: string;
  #authority?: string;
  #blocked = false;
  #generation = 0;
  #closed = false;
  #busy?: Promise<void>;
  #controller?: AbortController;
  #timer?: ReturnType<typeof setInterval>;
  constructor(readonly options: Options) {}
  get now(): number {
    return (this.options.now ?? Date.now)();
  }
  #identity(): { account: string; organizationId: string } | undefined {
    const owner = this.options.owner(),
      key = owner ? owner.account + "\0" + owner.organizationId : undefined,
      source = this.options.authority();
    const authority = JSON.stringify([
      source.required,
      source.perimeter,
      source.organizationId,
      source.authorityId,
    ]);
    if (key !== this.#owner || authority !== this.#authority) {
      this.#owner = key;
      this.#authority = authority;
      this.#active = undefined;
      this.#blocked = source.required;
      this.#generation++;
      this.#controller?.abort();
    }
    return owner;
  }
  #accept(version: LimitsVersion): boolean {
    const authority = this.options.authority();
    if (
      authority.required &&
      authority.organizationId !== undefined &&
      version.organizationId !== authority.organizationId
    ) {
      this.#active = undefined;
      this.#blocked = true;
      return false;
    }
    const unknown = version.limits.filter(
      (limit) => !(ORGANIZATION_LIMITS as readonly string[]).includes(limit),
    );
    if (unknown.length && this.options.authority().required) {
      this.#active = undefined;
      this.#blocked = true;
      this.options.report(
        "Limites obligatoires invalides : limite inconnue ; capacités encadrées indisponibles.",
      );
      return false;
    }
    if (unknown.length)
      this.options.report(
        "Limites d’organisation inconnues ignorées par cette version.",
      );
    this.#active = Object.freeze({
      ...version,
      limits: Object.freeze([...version.limits]),
    });
    this.#blocked = false;
    return true;
  }
  async initialize(signal: AbortSignal): Promise<void> {
    const owner = this.#identity(),
      authority = this.options.authority();
    this.#blocked = authority.required;
    if (owner)
      try {
        const cache = this.options.readCache();
        if (object(cache) && cache["account"] === owner.account) {
          const value = parsed(cache["value"], owner.organizationId, this.now);
          if (
            value &&
            (!authority.required || authority.authorizedCache?.(value))
          )
            this.#accept(value);
        }
      } catch {
        /* No cache can create required authority. */
      }
    if (authority.required) await this.refresh(signal);
    else void this.refresh(signal);
  }
  refresh(parent: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#busy) return this.#busy;
    this.#busy = this.#refresh(parent).finally(() => {
      this.#busy = undefined;
    });
    return this.#busy;
  }
  async #refresh(parent: AbortSignal): Promise<void> {
    const owner = this.#identity();
    if (!owner) {
      this.#blocked = this.options.authority().required;
      return;
    }
    const generation = this.#generation,
      controller = new AbortController();
    this.#controller = controller;
    const signal = AbortSignal.any([parent, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.options.load(this.#active?.version, signal, owner),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Limits timeout"));
          }, this.options.timeoutMs ?? 5000);
        }),
      ]);
      const liveOwner = this.#identity();
      if (
        signal.aborted ||
        this.#closed ||
        generation !== this.#generation ||
        liveOwner?.organizationId !== owner.organizationId ||
        liveOwner.account !== owner.account
      )
        return;
      if (
        object(response) &&
        response["notModified"] === true &&
        response["version"] === this.#active?.version &&
        response["organizationId"] === owner.organizationId &&
        this.#active &&
        this.#active.validUntil > this.now
      )
        return;
      const value = parsed(response, owner.organizationId, this.now);
      if (!value) {
        if (this.options.authority().required) {
          this.#active = undefined;
          this.#blocked = true;
        }
        this.options.report(
          "Version des limites invalide ; aucune permission élargie.",
        );
        return;
      }
      if (this.#accept(value))
        try {
          this.options.writeCache(value, owner.account);
        } catch {
          this.options.report(
            "Cache des limites indisponible ; version conservée en mémoire.",
          );
        }
    } catch {
      if (!this.#active || this.#active.validUntil <= this.now) {
        this.#active = undefined;
        this.#blocked = this.options.authority().required;
      }
      this.options.report(
        "Limites d’organisation injoignables ; cache autorisé utilisé si disponible.",
      );
    } finally {
      clearTimeout(timer);
      if (this.#controller === controller) this.#controller = undefined;
      controller.abort();
    }
  }
  refusal(
    capability: "local" | "remote" | OrganizationLimit,
  ): string | undefined {
    if (this.#closed) return "Session des limites terminée.";
    this.#identity();
    if (this.#active && this.#active.validUntil <= this.now) {
      this.#active = undefined;
      this.#blocked = this.options.authority().required;
    }
    const authority = this.options.authority();
    const remote = capability === "remote" || capability === "remote_sessions";
    if (this.#blocked && (authority.perimeter === "all" || remote))
      return "Capacité indisponible : source obligatoire des limites de l’organisation absente ou invalide.";
    if (authority.required && authority.perimeter === "remote" && !remote)
      return undefined;
    const limit = capability === "remote" ? "remote_sessions" : capability;
    if (this.#active?.limits.includes(limit))
      return "Fonction désactivée par la politique de votre organisation.";
    return undefined;
  }
  start(intervalMs: number, signal: AbortSignal): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(
      () => {
        void this.refresh(signal);
      },
      Math.max(1000, intervalMs),
    );
    this.#timer.unref();
  }
  close(): void {
    this.#closed = true;
    this.#generation++;
    this.#controller?.abort();
    clearInterval(this.#timer);
  }
}
