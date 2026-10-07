// Implements: SPEC-HOK-004 (§ 5.1, § 5.3 steps 1 to 4, FA-01, FA-02, EF-01 to EF-05, ERR-01 to ERR-03, RG-01, ENF-01)
// An `http` hook: the payload in a JSON POST, a decision in the response; never towards an internal address (SSRF).

import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { HttpAction } from "./config";

export type Resolver = (host: string) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;

export interface HttpHookOptions {
  readonly timeoutMs: number;
  /** `hooksConfig.http.allowedUrls`: undefined when the list is not defined (EF-04). */
  readonly allowedUrls?: readonly string[];
  readonly allowedEnvVars: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly outputMaxSize: number;
  readonly signal?: AbortSignal;
  /** Name resolution; the system resolver by default (replaced in the tests). */
  readonly resolve?: Resolver;
  /** Connections kept for reuse (ENF-01). */
  readonly agents?: HttpAgents;
}

export interface HttpRun {
  /** The request was not sent (FA-01, ERR-01). */
  readonly refused?: string;
  readonly status?: number;
  readonly body: string;
  readonly timedOut: boolean;
  /** Network failure (EF-05: never blocking). */
  readonly error?: string;
  /** Variables left as they are (ERR-03). */
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

export interface HttpAgents {
  readonly http: HttpAgent;
  readonly https: HttpsAgent;
}

export function createHttpAgents(): HttpAgents {
  return { http: new HttpAgent({ keepAlive: true, maxSockets: 8 }), https: new HttpsAgent({ keepAlive: true, maxSockets: 8 }) };
}

const MAX_REDIRECTS = 5;
const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function v4Parts(ip: string): number[] {
  return ip.split(".").map(Number);
}

/** Why `ip` must not be contacted, or undefined (EF-02): private, loopback, link-local, cloud metadata and reserved ranges. */
export function forbiddenAddress(ip: string): string | undefined {
  if (isIP(ip) === 4) {
    const [a, b] = v4Parts(ip) as [number, number, number, number];
    if (a === 127) return "boucle locale";
    if (a === 169 && b === 254) return "lien local ou métadonnées cloud";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "adresse privée";
    if (a === 100 && b >= 64 && b <= 127) return "adresse partagée (dont métadonnées cloud)";
    if (a === 0 || a >= 224 || (a === 192 && b === 0 && v4Parts(ip)[2] === 0) || (a === 198 && (b === 18 || b === 19))) return "adresse réservée";
    return undefined;
  }
  if (isIP(ip) === 6) {
    const x = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
    const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return forbiddenAddress(mapped[1]!);
    const hex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) {
      const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
      return forbiddenAddress([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
    if (x === "::1") return "boucle locale";
    if (x === "::") return "adresse réservée";
    const first = parseInt(x.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return "adresse privée (dont métadonnées cloud)";
    if ((first & 0xffc0) === 0xfe80) return "lien local";
    if ((first & 0xff00) === 0xff00) return "adresse de diffusion";
    if (first === 0x2002) {
      // 6to4: the IPv4 address is carried in the second and third groups.
      const [g1, g2] = x.split(":").slice(1, 3).map((g) => parseInt(g || "0", 16)) as [number, number];
      return forbiddenAddress([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255].join("."));
    }
    return undefined;
  }
  return "adresse illisible";
}

/** `localhost` written as such: the only case where `http` and the loopback are admitted (§ 5.1, EF-02). */
function explicitLocal(url: URL): boolean {
  return LOCAL_NAMES.has(url.hostname.toLowerCase());
}

/** `*` stands for any run of characters; the whole URL must match (EF-04). */
function urlAllowed(url: URL, patterns: readonly string[]): boolean {
  return patterns.some((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, (c) => `\\${c}`).replace(/\*/g, ".*")}$`).test(url.href));
}

/** Step 1 for one URL, before any name resolution; the address itself is checked when connecting (RG-01). */
function checkUrl(url: URL, allowedUrls: readonly string[] | undefined): string | undefined {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && explicitLocal(url))) return "seul https est admis, ou http vers l'hôte local";
  if (allowedUrls !== undefined && !urlAllowed(url, allowedUrls)) return "URL absente de hooksConfig.http.allowedUrls";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !explicitLocal(url)) return forbiddenAddress(host);
  return undefined;
}

/** Step 2: `${VAR}` replaced only when `VAR` is listed (EF-03); otherwise left as it is, with a warning (ERR-03). */
export function substituteHeaders(headers: Readonly<Record<string, string>>, allowed: readonly string[], env: Readonly<Record<string, string | undefined>>, warnings: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    out[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, v: string) => {
      if (allowed.includes(v)) return env[v] ?? "";
      if (!warnings.some((w) => w.includes(`\`${v}\``))) warnings.push(`Variable \`${v}\` non autorisée dans un crochet HTTP.`);
      return whole;
    });
  return out;
}

class Refused extends Error {}

/** Steps 1 to 4, with the redirections that pass the same checks (FA-02). */
export async function runHttpHook(action: HttpAction, payload: string, o: HttpHookOptions): Promise<HttpRun> {
  const started = Date.now();
  const warnings: string[] = [];
  const headers = substituteHeaders(action.headers ?? {}, o.allowedEnvVars, o.env, warnings);
  const resolve: Resolver = o.resolve ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
  const done = (r: Omit<HttpRun, "warnings" | "durationMs">): HttpRun => ({ ...r, warnings, durationMs: Date.now() - started });
  let url = new URL(action.url);
  let method = "POST";
  let body: string | undefined = payload;
  const deadline = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([deadline, o.signal]) : deadline;
  for (let hop = 0; ; hop++) {
    const refusal = checkUrl(url, o.allowedUrls);
    if (refusal) return done({ refused: refusal, body: "", timedOut: false });
    let res: IncomingMessage;
    let text: string;
    try {
      ({ res, text } = await send(url, method, body, headers, resolve, o, signal));
    } catch (e) {
      if (e instanceof Refused) return done({ refused: e.message, body: "", timedOut: false });
      if (deadline.aborted) return done({ body: "", timedOut: true });
      return done({ body: "", timedOut: false, error: e instanceof Error ? e.message : String(e) });
    }
    const location = res.headers.location;
    if (res.statusCode !== undefined && [301, 302, 303, 307, 308].includes(res.statusCode) && location) {
      if (hop >= MAX_REDIRECTS) return done({ body: "", timedOut: false, error: "trop de redirections" });
      url = new URL(location, url);
      if (res.statusCode !== 307 && res.statusCode !== 308) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return done({ status: res.statusCode, body: text, timedOut: false });
  }
}

function send(url: URL, method: string, body: string | undefined, headers: Record<string, string>, resolve: Resolver, o: HttpHookOptions, signal: AbortSignal): Promise<{ res: IncomingMessage; text: string }> {
  const local = explicitLocal(url);
  let refusal: string | undefined;
  // RG-01: the address is checked when the connection is made, on the very address contacted.
  const lookup = (host: string, _opts: unknown, cb: (e: Error | null, a?: unknown, f?: number) => void) => {
    resolve(host).then(
      (all) => {
        const bad = all.length === 0 ? "nom sans adresse" : all.map((a) => (local && forbiddenAddress(a.address) === "boucle locale" ? undefined : forbiddenAddress(a.address))).find((r) => r !== undefined);
        if (bad) {
          refusal = `${host} : ${bad}`;
          cb(new Refused(refusal));
        }
        else cb(null, all.map((a) => ({ address: a.address, family: a.family })));
      },
      (e: Error) => cb(e),
    );
  };
  const https = url.protocol === "https:";
  return new Promise((ok, fail) => {
    const req = (https ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}) },
        lookup: lookup as never,
        agent: o.agents ? (https ? o.agents.https : o.agents.http) : undefined,
        signal,
      },
      (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size >= o.outputMaxSize) return;
          const part = c.subarray(0, o.outputMaxSize - size);
          size += part.length;
          parts.push(part);
        });
        res.on("end", () => ok({ res, text: Buffer.concat(parts).toString("utf8") }));
        res.on("error", fail);
      },
    );
    req.on("error", (e) => fail(refusal !== undefined ? new Refused(refusal) : e));
    req.end(body);
  });
}
