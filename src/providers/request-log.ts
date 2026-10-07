// Implements: SPEC-API-002 (EF-07 authentication headers never logged, CA-04)
// Supports: SPEC-OBS-012 (minimal debug journal)

import type { ModelProvider } from "./types";

export interface RequestLogOptions {
  readonly providerId: string;
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly authToken?: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Logs every request in the debug journal: model, sizes and the headers sent. The authentication headers are
 * named but their values are always masked (the journal masks every secret-looking field as well).
 */
export function withRequestLog(provider: ModelProvider, options: RequestLogOptions, log: (message: string, data: unknown) => void): ModelProvider {
  const headers: Record<string, string> = { ...options.headers };
  if (options.apiKey !== undefined) headers[options.providerId === "anthropic" ? "x-api-key" : "authorization"] = "••••";
  if (options.authToken !== undefined) headers["authorization"] = "••••";
  return {
    id: provider.id,
    stream(request, signal) {
      log("request", {
        provider: options.providerId,
        baseURL: options.baseURL,
        model: request.model.id,
        messages: request.history.length,
        tools: request.tools.length,
        maxOutputTokens: request.maxOutputTokens,
        effort: request.effort,
        headers,
      });
      return provider.stream(request, signal);
    },
  };
}
