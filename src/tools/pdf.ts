// Implements: SPEC-OUT-002 (§ 5.1 PDF row, § 5.3 point 6, FA-03, EF-04, ERR-07, CA-04)
// Supports: decision D-06 (PDF in lot 2), gap E-082 (text of the pages, without their images)
// PDF documents read with pdf.js (through `unpdf`, without worker nor native component): text of the requested pages.

import { readFileSync, type Stats } from "node:fs";
import { getDocumentProxy } from "unpdf";
import { textOutcome, type ToolContext, type ToolOutcome } from "./types";

/** pdf.js writes its warnings on the console: only errors would reach it, and they are caught. */
const PDF_ERRORS_ONLY = 0;

/** Range `n` or `n-m` (§ 6), checked against the number of pages. */
function pageRange(pages: string, total: number): { first: number; last: number } | string {
  const [a, b] = pages.split("-").map((n) => Number.parseInt(n, 10));
  const first = a!;
  const last = b ?? first;
  if (first < 1 || last < first) return `Invalid page range: ${pages}. Use n or n-m, with n ≤ m.`;
  if (last > total) return `Pages out of range: the document has ${total} page${total === 1 ? "" : "s"}.`;
  return { first, last };
}

export async function readPdf(path: string, stats: Stats, pages: string | undefined, key: string, ctx: ToolContext): Promise<ToolOutcome> {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return textOutcome("Unreadable PDF: the file does not start with a PDF signature.", true); // § 5.1 extension and signature
  let doc;
  try {
    doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: PDF_ERRORS_ONLY });
  } catch {
    return textOutcome("Unreadable PDF: it is protected by a password or damaged.", true); // ERR-07
  }
  try {
    const total = doc.numPages;
    const max = ctx.settings.readPdfMaxPages;
    let first = 1;
    let last = total;
    if (pages !== undefined) {
      const range = pageRange(pages, total);
      if (typeof range === "string") return textOutcome(range, true);
      ({ first, last } = range);
      if (last - first + 1 > max) return textOutcome(`At most ${max} pages can be read at once: give a smaller range.`, true);
    } else if (total > max) {
      // FA-03, CA-04: a long document is read by ranges.
      return textOutcome(`This PDF has ${total} pages, more than the ${max} that can be read at once: give pages, such as 1-${max}.`, true);
    }
    const parts: string[] = [];
    for (let n = first; n <= last; n++) {
      if (ctx.signal.aborted) break;
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      parts.push(`--- Page ${n} of ${total} ---\n${text === "" ? "[No text on this page: it may hold only images.]" : text}`);
    }
    const complete = first === 1 && last === total;
    ctx.readState.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, complete });
    // EF-04: a partial read says so.
    const note = complete ? "" : `\n\n[Pages ${first}-${last} of ${total} shown. Use pages to read others.]`;
    return textOutcome(parts.join("\n\n") + note);
  } catch {
    return textOutcome("Unreadable PDF: it is protected by a password or damaged.", true); // ERR-07
  } finally {
    await doc.cleanup().catch(() => undefined);
  }
}
