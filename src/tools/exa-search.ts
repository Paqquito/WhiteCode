// Supports: SPEC-OUT-013 (anonymous public search and attributable results).
import { HttpConnection } from "../connectors/http-client";
import { DEFAULT_WEB_SEARCH_ENDPOINT } from "../config/settings-schema";
import type { SearchInput } from "./search-web";

export class SearchRateLimited extends Error {}

/** The hosted tool returns ranked text records, each with a title, URL and highlights. */
export async function searchExa(input: SearchInput, network: typeof fetch, signal: AbortSignal) {
  let rateLimited = false;
  const connection = await HttpConnection.open({
    name: "web-search", url: DEFAULT_WEB_SEARCH_ENDPOINT, transport: "http", headers: {},
    clientInfo: { name: "web-search", version: "1.0" }, connectTimeoutMs: 8_000, signal,
    fetch: (async (url, options) => {
      const response = await network(url, { ...options, redirect: "error" });
      if (response.status === 429) rateLimited = true;
      return response;
    }) as typeof fetch,
  }).catch(error => { if (rateLimited) throw new SearchRateLimited(); throw error; });
  try {
    let objective = "Find authoritative sources that directly answer the search query.";
    if (input.include_domains?.length) objective += " Only return sources from: " + input.include_domains.join(", ");
    if (input.exclude_domains?.length) objective += " Exclude sources from: " + input.exclude_domains.join(", ");
    const reply = await connection.callTool("web_search_exa", { query: input.query, objective, numResults: 5 }, { signal, timeoutMs: 15_000 });
    const text = reply.content.flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n").trim().replace(/\r\n/g, "\n");
    if ((reply.isError || !text.startsWith("Title:")) && /rate limit|too many requests|quota exceeded/i.test(text)) throw new SearchRateLimited();
    if (reply.isError) throw new Error("Search unavailable");
    if (/^no (?:search )?results\b/i.test(text)) return [];
    const results = [];
    for (const record of text.split(/\n(?=Title: )/)) {
      const header = /^Title:[ \t]*([^\n]+)\n(?:(?:Author|Published(?: Date)?):[^\n]*\n)*URL:[ \t]*(https?:\/\/[^\s]+)[ \t]*(?:\n|$)/.exec(record);
      if (!header) continue;
      const excerpt = record.slice(header[0].length).replace(/^(?:(?:Published(?: Date)?|Author):[^\n]*\n)*(?:(?:Highlights|Text|Summary):[ \t]*\n?)?/, "").trim();
      results.push({ title: header[1]!.trim(), url: header[2]!, excerpt });
    }
    if (!results.length) throw new Error("Invalid search results");
    return results;
  } catch (error) {
    if (rateLimited) throw new SearchRateLimited();
    throw error;
  } finally { await connection.close(); }
}
