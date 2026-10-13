// Implements: SPEC-PLA-001 (local five-field cron, seasonal time), SPEC-OUT-031 (CA-01/03, EF-01), gap E-152.
const LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
function parse(expression: string): Set<number>[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || expression.length > 200) throw new Error("Expression de planification invalide.");
  return fields.map((field, index) => {
    const [minimum, maximum] = LIMITS[index]!; const values = new Set<number>();
    for (const term of field.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term);
      if (!match) throw new Error("Expression de planification invalide.");
      const step = Number(match[2] ?? 1), range = match[1] === "*" ? [minimum, maximum] : match[1]!.split("-").map(Number);
      const start = range[0]!, end = range[1] ?? (match[2] ? maximum : start);
      if (!Number.isSafeInteger(step) || step < 1 || step > maximum + 1 || start < minimum || end > maximum || start > end) throw new Error("Expression de planification invalide.");
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return values;
  });
}
export function wallMinute(time: number): string {
  const d = new Date(time), pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function validateCron(expression: string): void {
  const fields = parse(expression), raw = expression.trim().split(/\s+/);
  if (raw[4] === "*" && ![...fields[3]!].some(month => [...fields[2]!].some(day => day <= new Date(2028, month, 0).getDate()))) throw new Error("Expression sans échéance future.");
}
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (/^\*\/[1-9]\d*$/.test(fields[0]!) && fields.slice(1).every(f => f === "*")) return `toutes les ${fields[0]!.slice(2)} minutes`;
  if (/^\d+$/.test(fields[0]!) && /^\d+$/.test(fields[1]!) && fields.slice(2).every(f => f === "*")) return `tous les jours à ${fields[1]} h ${fields[0]!.padStart(2, "0")}`;
  return `minutes ${fields[0]}, heures ${fields[1]}, jours ${fields[2]}, mois ${fields[3]}, jours de semaine ${fields[4]}`;
}
export function nextOccurrence(expression: string, after: number, lastWall?: string): number {
  const fields = parse(expression), raw = expression.trim().split(/\s+/), dayAny = raw[2] === "*", weekAny = raw[4] === "*";
  // Reject impossible month/day combinations without scanning millions of minutes.
  if (weekAny && ![...fields[3]!].some(month => [...fields[2]!].some(day => day <= new Date(2028, month, 0).getDate()))) throw new Error("Expression sans échéance future.");
  const ceiling = after + 8 * 366 * 86400_000;
  for (let time = Math.floor(after / 60_000) * 60_000 + 60_000; time <= ceiling; time += 60_000) {
    const date = new Date(time), day = fields[2]!.has(date.getDate()), week = fields[4]!.has(date.getDay());
    if (fields[0]!.has(date.getMinutes()) && fields[1]!.has(date.getHours()) && fields[3]!.has(date.getMonth() + 1) && (dayAny ? week : weekAny ? day : day || week) && (!lastWall || wallMinute(time) > lastWall)) return time;
  }
  throw new Error("Expression sans échéance future.");
}
