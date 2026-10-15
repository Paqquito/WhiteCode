// Supports: SPEC-SES-001 (protected storage access), gap E-181.
import { storeStat as lstatSync, storeList as readdirSync } from "./private-storage";
// Implements: SPEC-SES-005 (EF-01), SPEC-SES-010 (CA-01/02), SPEC-CMD-082 (CA-01, EF-01/02).
// Supports: gap E-171 (bounded in-memory candidates, explicit search and local zero-cost reindex).

import { join } from "node:path";
import { activeChain, readTranscript, sessionLabels, sessionTitle, type SessionInfo } from "./sessions";
import { decodeProjectKey, projectKey, TranscriptWriter } from "./transcript";

export function allSessions(folder: string): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  try {
    if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) return [];
    for (const key of readdirSync(folder)) {
      const project = decodeProjectKey(key), directory = join(folder, key);
      if (projectKey(project) !== key || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) continue;
      for (const file of readdirSync(directory)) {
        if (!/^[0-9a-f-]{36}\.jsonl$/i.test(file)) continue;
        const path = join(directory, file), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) continue;
        sessions.push({ id: file.slice(0, -6), path, project, modifiedMs: stat.mtimeMs });
        if (sessions.length >= 5000) break;
      }
      if (sessions.length >= 5000) break;
    }
  } catch { /* A disappearing entry leaves already discovered sessions available. */ }
  return sessions.sort((a, b) => b.modifiedMs - a.modifiedMs || a.id.localeCompare(b.id));
}
const firstMessage = (records: ReturnType<typeof readTranscript>["records"]): string => {
  const content = records.find(record => record.type === "user")?.data["content"];
  return Array.isArray(content) ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join(" ") : "";
};
export function sessionEntry(session: SessionInfo) {
  const records = readTranscript(session.path).records;
  return { session, title: sessionTitle(records) ?? session.id.slice(0, 8), first: firstMessage(records).slice(0, 240), labels: sessionLabels(records) };
}
const words = (text: string): string[] => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
export async function searchSessions(sessions: readonly SessionInfo[], query: string, o: { readonly limit: number; readonly signal: AbortSignal; readonly sample?: (text: string, signal: AbortSignal) => Promise<string | undefined> }) {
  const tokens = words(query), entries = sessions.flatMap(session => { try { return [sessionEntry(session)]; } catch { return []; } });
  const score = (entry: typeof entries[number]) => tokens.reduce((total, token) => total + (words(entry.title).includes(token) ? 3 : 0) + (words(entry.first).includes(token) ? 1 : 0) + (entry.labels.includes(token) ? 4 : 0), 0);
  const ordered = entries.map((entry, index) => ({ entry, index, score: score(entry) })).sort((a, b) => b.score - a.score || a.index - b.index).map(value => value.entry);
  if (!o.sample || !query.trim()) return ordered;
  const candidates = ordered.slice(0, Math.max(1, Math.min(40, o.limit))), controller = new AbortController(), signal = AbortSignal.any([o.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = JSON.stringify({ query: query.slice(0, 1000), candidates: candidates.map((entry, index) => ({ id: `candidate-${index}`, title: entry.title.slice(0, 120), first: entry.first, date: new Date(entry.session.modifiedMs).toISOString() })) });
    const answer = await Promise.race([o.sample(input, signal), new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, 4000); })]);
    o.signal.throwIfAborted();
    const ids: unknown = JSON.parse(answer ?? "null");
    if (!Array.isArray(ids) || ids.length > candidates.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !/^candidate-\d+$/.test(id) || !candidates[Number(id.slice(10))])) return ordered;
    const ranked = ids.map(id => candidates[Number(id.slice(10))]!), paths = new Set(ranked.map(entry => entry.session.path));
    return [...ranked, ...ordered.filter(entry => !paths.has(entry.session.path))];
  } catch (error) { if (o.signal.aborted) throw error; return ordered; }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function reindexSessions(sessions: readonly SessionInfo[], signal: AbortSignal, progress?: (done: number) => void): Promise<number> {
  let done = 0;
  for (const session of sessions) {
    signal.throwIfAborted();
    const records = readTranscript(session.path).records;
    if (sessionTitle(records)) continue;
    let writer: TranscriptWriter;
    try { writer = new TranscriptWriter({ sessionsDir: join(session.path, "..", ".."), projectRealPath: session.project, sessionId: session.id, parentId: records.at(-1)?.id, active: true }); } catch { continue; }
    try {
      const current = readTranscript(session.path).records;
      if (!sessionTitle(current) && current.at(-1)?.id === records.at(-1)?.id) { writer.append("system", { event: "title", title: firstMessage(current).replace(/\s+/g, " ").trim().slice(0, 100) || `Session ${session.id.slice(0, 8)}`, source: "reindex" }); writer.flush(); if (writer.warning) throw new Error(writer.warning); progress?.(++done); }
    } finally { writer.close(); }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted(); return done;
}
