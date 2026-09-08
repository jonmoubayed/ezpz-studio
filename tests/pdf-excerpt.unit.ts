import assert from "node:assert/strict";
import { excerptQueries, locatePdfExcerpt } from "../src/lib/pdf-excerpt";
import type { PdfDocumentObject, PdfEngine, SearchResult } from "@embedpdf/models";

const document = { pages: [{ size: { width: 600, height: 800 } }, { size: { width: 600, height: 800 } }] } as PdfDocumentObject;
const match = (pageIndex: number) => ({ pageIndex, rects: [
  { origin: { x: 60, y: 160 }, size: { width: 120, height: 16 } },
  { origin: { x: 60, y: 180 }, size: { width: 240, height: 16 } },
] }) as SearchResult;
function engine(results: SearchResult[], seen: string[] = []) {
  return { searchAllPages: (_doc: unknown, query: string) => {
    seen.push(query);
    return { toPromise: async () => ({ results }), abort() {} };
  } } as unknown as PdfEngine;
}
assert.deepEqual(excerptQueries("... at least thirty (30) days…"), ["at least thirty (30) days"]);
assert.deepEqual(excerptQueries("..."), []);
const boxes = await locatePdfExcerpt(engine([match(1)]), document, "a quoted clause");
assert.deepEqual(boxes, [
  { page: 2, area: { left: 10, top: 20, width: 20, height: 2 } },
  { page: 2, area: { left: 10, top: 22.5, width: 40, height: 2 } },
]);
assert.deepEqual(await locatePdfExcerpt(engine([]), document, "absent text"), []);
assert.deepEqual(await locatePdfExcerpt(engine([match(0), match(1)]), document, "repeated clause"), []);
assert.equal((await locatePdfExcerpt(engine([match(0), match(1)]), document, "repeated clause", "Page 2, section 2.3"))[0].page, 2);
assert.deepEqual(await locatePdfExcerpt(engine([match(1), match(1)]), document, "repeated on same page", "Page 2"), []);
const seen: string[] = [];
await locatePdfExcerpt(engine([], seen), document, "some excerpt", undefined, AbortSignal.abort());
assert.deepEqual(seen, [], "Cancelled field selections must not start more searches");
console.log("PASS: excerpt grounding, real multiline geometry, page disambiguation, absent/ambiguous quotes and cancellation.");
