// Supports: SPEC-MCP-017 (company proxy without forwarding account tokens to third parties), gap E-192.
interface Owner {
  account: string;
  organizationId: string;
}
interface Account {
  profile(): Promise<
    { account: string; organization: { id: string } } | undefined
  >;
  request(
    service: "connectors",
    path: string,
    body: unknown,
    signal: AbortSignal,
    owner?: Owner,
  ): Promise<unknown>;
}
interface Options {
  readonly account: Account;
  readonly webUrl: string;
  readonly network: typeof fetch;
  readonly enabled: () => boolean;
  readonly report: (text: string) => void;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export class WebConnectors {
  #owner?: Owner;
  #names = new Map<string, string>();
  readonly #base: URL;
  constructor(readonly options: Options) {
    this.#base = new URL(
      "api/connectors/relay/",
      options.webUrl.replace(/\/?$/, "/"),
    );
    if (
      this.#base.protocol !== "https:" ||
      this.#base.username ||
      this.#base.password ||
      this.#base.hash
    )
      throw Error("Invalid company connector endpoint.");
  }
  async load(
    signal: AbortSignal,
  ): Promise<
    | {
        scope: "extension";
        source: string;
        prefix: "web";
        content: {
          servers: Record<string, { transport: "http"; url: string }>;
        };
      }
    | undefined
  > {
    if (!this.options.enabled()) return;
    const profile = await this.options.account.profile();
    if (!profile) {
      this.#owner = undefined;
      this.#names.clear();
      return;
    }
    const owner = {
      account: profile.account,
      organizationId: profile.organization.id,
    };
    const raw = await this.options.account.request(
      "connectors",
      "list",
      undefined,
      signal,
      owner,
    );
    signal.throwIfAborted();
    const live = await this.options.account.profile();
    if (
      !live ||
      live.account !== owner.account ||
      live.organization.id !== owner.organizationId
    )
      throw Error("Company connector owner changed.");
    if (
      !object(raw) ||
      !Array.isArray(raw.connectors) ||
      raw.connectors.length > 100
    )
      throw Error("Invalid company connector catalogue.");
    const names = new Map<string, string>(),
      servers: Record<string, { transport: "http"; url: string }> = {};
    for (const row of raw.connectors) {
      if (
        !object(row) ||
        typeof row.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) ||
        typeof row.name !== "string" ||
        !/^[a-z][a-z0-9-]{0,43}$/.test(row.name) ||
        names.has(row.id) ||
        Object.hasOwn(servers, row.name)
      )
        throw Error("Invalid or duplicate company connector.");
      names.set(row.id, row.name);
      servers[row.name] = {
        transport: "http",
        url: new URL(row.id, this.#base).href,
      };
    }
    this.#owner = owner;
    this.#names = names;
    return {
      scope: "extension",
      source: "company:web-connectors",
      prefix: "web",
      content: { servers },
    };
  }
  readonly fetch: typeof fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      url.origin !== this.#base.origin ||
      !url.pathname.startsWith(this.#base.pathname)
    )
      return this.options.network(input, init);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !this.options.enabled() ||
      !this.#owner
    )
      return new Response("Company connector unavailable.", { status: 403 });
    const id = url.pathname.slice(this.#base.pathname.length);
    if (!this.#names.has(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      return new Response("Unknown company connector.", { status: 404 });
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    const signal = init.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const profile = await this.options.account.profile();
    if (
      !profile ||
      profile.account !== this.#owner.account ||
      profile.organization.id !== this.#owner.organizationId
    )
      return new Response("Company account changed.", { status: 403 });
    if (typeof init.body !== "string" || Buffer.byteLength(init.body) > 192000)
      return new Response("MCP request too large.", { status: 413 });
    const message: unknown = JSON.parse(init.body);
    if (
      !object(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    )
      return new Response("Invalid MCP request.", { status: 400 });
    const owner = this.#owner,
      raw = await this.options.account.request(
        "connectors",
        id + "/rpc",
        { message },
        signal,
        owner,
      ),
      live = await this.options.account.profile();
    if (
      !live ||
      live.account !== owner.account ||
      live.organization.id !== owner.organizationId
    )
      throw Error("Company account changed during connector request.");
    return message.id === undefined
      ? new Response(null, { status: 202 })
      : Response.json(raw, { headers: { "Cache-Control": "no-store" } });
  }) as typeof fetch;
}
