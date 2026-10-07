// Supports: SPEC-OUT-003 (EF-06 difference shown before confirmation), SPEC-OUT-004 (§ 7.1), SPEC-OUT-005 (§ 5.3 point 4)
// Line difference (Myers algorithm) rendered as a unified difference for approval requests and events.

type Op = { readonly kind: "same" | "del" | "add"; readonly line: string };

/** Beyond this product of line counts, the difference is shown as a whole replacement. */
const MAX_WORK = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function myers(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // Backtrack.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      y--;
      ops.push({ kind: "same", line: a[--x]! });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "add", line: b[--y]! });
      else ops.push({ kind: "del", line: a[--x]! });
    }
  }
  return ops.reverse();
}

/** Unified difference between two texts (LF line endings), with `context` lines around each change; empty when equal. */
export function unifiedDiff(before: string, after: string, label: string, context = 3): string {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  const ops: Op[] =
    a.length * b.length > MAX_WORK
      ? [...a.map((line): Op => ({ kind: "del", line })), ...b.map((line): Op => ({ kind: "add", line }))]
      : myers(a, b);
  const out = [`--- ${label}`, `+++ ${label}`];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < ops.length) {
    if (ops[i]!.kind === "same") {
      i++;
      oldLine++;
      newLine++;
      continue;
    }
    // Hunk: back up `context` lines, extend while changes are closer than 2 × context.
    const startOp = Math.max(0, i - context);
    const back = i - startOp;
    let end = i;
    let gap = 0;
    while (end < ops.length) {
      if (ops[end]!.kind === "same") {
        gap++;
        if (gap > 2 * context) break;
      } else gap = 0;
      end++;
    }
    end = Math.min(ops.length, end - Math.max(0, gap - context));
    const hunk = ops.slice(startOp, end);
    const oldStart = oldLine - back;
    const newStart = newLine - back;
    const oldCount = hunk.filter((o) => o.kind !== "add").length;
    const newCount = hunk.filter((o) => o.kind !== "del").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of hunk) out.push(`${o.kind === "same" ? " " : o.kind === "del" ? "-" : "+"}${o.line}`);
    for (const o of ops.slice(i, end)) {
      if (o.kind !== "add") oldLine++;
      if (o.kind !== "del") newLine++;
    }
    i = end;
  }
  return out.join("\n");
}
