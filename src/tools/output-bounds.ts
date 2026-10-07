// Implements: SPEC-OUT-008 (§ 5.3 point 7, EF-08, edge cases: binary output, terminal escape sequences), SPEC-OUT-001 (FA-01 preview of a large result)

/** Terminal control sequences (CSI, OSC, single-character escapes) removed for the model. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Text for the model: escape sequences removed, CRLF normalised, a binary output replaced by a mention. */
export function cleanOutput(bytes: Buffer): string {
  if (bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0)) return `[binary output omitted: ${bytes.length} bytes]`;
  return bytes.toString("utf8").replace(ESCAPES, "").replace(/\r\n/g, "\n");
}

export interface Bounded {
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedLines: number;
}

/** Keeps the beginning and the end within `limit` characters; the middle is replaced by the number of omitted lines. */
export function boundText(text: string, limit: number): Bounded {
  if (text.length <= limit) return { text, truncated: false, omittedLines: 0 };
  const half = Math.floor(limit / 2);
  let head = text.slice(0, half);
  let tail = text.slice(text.length - half);
  // Cut on line boundaries when a line break is close enough.
  const headCut = head.lastIndexOf("\n");
  if (headCut > half * 0.8) head = head.slice(0, headCut + 1);
  const tailCut = tail.indexOf("\n");
  if (tailCut !== -1 && tailCut < half * 0.2) tail = tail.slice(tailCut + 1);
  const middle = text.slice(head.length, text.length - tail.length);
  const omittedLines = middle.split("\n").length - 1;
  return { text: `${head}\n[… ${omittedLines} lines omitted (${middle.length} characters) …]\n${tail}`, truncated: true, omittedLines };
}
