// Implements: SPEC-IHM-030 (CA-01, EF-01/03), SPEC-IHM-031 (CA-01, EF-01/02), SPEC-CMD-066 (CA-01), gap E-150.
import { readdir as diskNames, lstat as diskStat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { encryptedStore, storeList, storeStat, storeRead } from "./private-storage";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { TranscriptRecord } from "./transcript";

export interface SessionStatistics { readonly days: ReadonlyMap<string, number>; readonly attempts: readonly number[]; readonly sessions: number; readonly userMessages: number }
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const readdir = async (path: string) => encryptedStore(path) ? storeList(path) : diskNames(path);
const lstat = async (path: string) => encryptedStore(path) ? storeStat(path) : diskStat(path);

/** Asynchronous disk reads yield to input handling; the report never needs an external service. */
export async function loadSessionStatistics(directory: string): Promise<SessionStatistics> {
  const days = new Map<string, number>(), attempts: number[] = []; let userMessages = 0;
  let projects: string[]; try { projects = await readdir(directory); } catch { return { days, attempts, sessions: 0, userMessages }; }
  for (const project of projects) {
    const folder = join(directory, project);
    let files: string[]; try { if (!(await lstat(folder)).isDirectory()) continue; files = await readdir(folder); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(folder, file); let count = 0; const activeDays = new Set<string>();
      try {
        if (!(await lstat(path)).isFile()) continue;
        const input = encryptedStore(path) ? Readable.from([storeRead(path, "utf8")]) : createReadStream(path, { encoding: "utf8" });
        const lines = createInterface({ input, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            // Writer puts the record type before its potentially large tool payload.
            if (!/"type"\s*:\s*"user"/.test(line.slice(0, 200))) continue;
            try {
              const record = JSON.parse(line) as TranscriptRecord;
              if (record.type === "user" && record.data && record.data["synthetic"] !== true && Number.isFinite(Date.parse(record.ts))) { count++; activeDays.add(dayKey(new Date(record.ts))); }
            } catch { /* interrupted final line */ }
          }
        } finally { lines.close(); input.destroy(); }
      } catch { continue; }
      if (!count) continue;
      attempts.push(count); userMessages += count;
      for (const key of activeDays) days.set(key, (days.get(key) ?? 0) + 1);
    }
  }
  return { days, attempts, sessions: attempts.length, userMessages };
}

export function renderSessionStatistics(statistics: SessionStatistics): string {
  if (!statistics.sessions) return "Aucune session avec échange utilisateur dans l'historique local.";
  const lines = [`Statistiques locales : ${statistics.sessions} sessions, ${statistics.userMessages} tentatives.`, "Carte d'activité : nombre de sessions actives pour chaque jour ; . = aucune."];
  const months = [...new Set([...statistics.days.keys()].map(day => day.slice(0, 7)))].sort();
  for (const month of months) {
    const [year, index] = month.split("-").map(Number) as [number, number];
    const first = new Date(year, index - 1, 1), last = new Date(year, index, 0).getDate();
    const cells = Array.from({ length: (first.getDay() + 6) % 7 }, () => "     ");
    for (let day = 1; day <= last; day++) cells.push(`${String(day).padStart(2, "0")}:${String(statistics.days.get(`${month}-${String(day).padStart(2, "0")}`) ?? ".").padEnd(2)}`);
    lines.push(`Calendrier ${month}`, "Lun   Mar   Mer   Jeu   Ven   Sam   Dim");
    for (let index = 0; index < cells.length; index += 7) lines.push(cells.slice(index, index + 7).join(" "));
  }
  lines.push("Tentatives par session :");
  const bins = [statistics.attempts.filter(count => count === 1).length, statistics.attempts.filter(count => count >= 2 && count <= 5).length, statistics.attempts.filter(count => count >= 6 && count <= 10).length, statistics.attempts.filter(count => count >= 11).length];
  const labels = ["1", "2 à 5", "6 à 10", "11 et plus"];
  const exact = bins.map(count => 100 * count / statistics.sessions), percentages = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, fraction: value - percentages[index]! })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const remainder = 100 - percentages.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < remainder; index++) percentages[order[index]!.index]!++;
  bins.forEach((count, index) => lines.push(`${labels[index]} : ${count} sessions (${percentages[index]} %)`));
  lines.push(`Moyenne : ${(statistics.userMessages / statistics.sessions).toFixed(2).replace(".", ",")} tentatives.`);
  return lines.join("\n");
}
