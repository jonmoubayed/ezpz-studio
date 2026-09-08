import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { PdfErrorCode } from "@embedpdf/models";
import type { Citation } from "../domain";

export function excerptQueries(excerpt: string): string[] {
  const text = excerpt.replace(/\.{3,}|…/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return [];
  // Full quotes first. Long, verbatim fragments can still locate excerpts
  // whose punctuation or surrounding model commentary differs from the PDF.
  const fragments = text.split(/[;.!?]\s+/).filter((s) => s.split(/\s+/).length >= 6);
  const words = text.split(/\s+/);
  const queries = [text, ...fragments];
  if (words.length > 10) {
    queries.push(words.slice(0, 10).join(" "), words.slice(-10).join(" "));
  }
  return [...new Set(queries)].slice(0, 8);
}

export async function locatePdfExcerpt(
  engine: PdfEngine,
  document: PdfDocumentObject,
  excerpt: string,
  location?: string,
  signal?: AbortSignal,
): Promise<Citation[]> {
  const preferredPage = Number(location?.match(/\bpage\s+(\d+)/i)?.[1]);
  for (const query of excerptQueries(excerpt)) {
    if (signal?.aborted) return [];
    const task = engine.searchAllPages(document, query);
    const abort = () => task.abort({ code: PdfErrorCode.Cancelled, message: "Source selection changed" });
    signal?.addEventListener("abort", abort, { once: true });
    let results;
    try {
      results = (await task.toPromise()).results;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    if (signal?.aborted) return [];
    const onPage = results.filter((r) => r.pageIndex + 1 === preferredPage);
    const candidates = onPage.length ? onPage : results;
    // Repeated phrases without a disambiguating page aren't a reliable citation.
    if (candidates.length !== 1) continue;
    const match = candidates[0];
    const size = document.pages[match.pageIndex]?.size;
    if (!size?.width || !size.height) continue;
    const citations = match.rects
      .filter((r) => r.size.width > 0 && r.size.height > 0)
      .map((r) => ({
        page: match.pageIndex + 1,
        area: {
          left: r.origin.x / size.width * 100,
          top: r.origin.y / size.height * 100,
          width: r.size.width / size.width * 100,
          height: r.size.height / size.height * 100,
        },
      }));
    if (citations.length) return citations;
  }
  return [];
}
