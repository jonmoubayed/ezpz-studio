# Bounding boxes without a parser

Choose **Original document · no parser** in the document parser selector and use
a PDF/image-capable OpenAI, Anthropic, or Gemini model. The extraction service
sends the original file directly; it does not run OCR, layout parsing, or text
matching to produce boxes. API configurations use `parser: {"name": "none"}`
with the `direct` harness. The page-extraction harness requires parsed pages.

For PDF and image input, each extraction leaf returns `value`, `confidence`, and
`evidence: [{"page": 1, "bbox": [0.1, 0.2, 0.4, 0.3], "text": "visible source"}]`.
Pages are physical, 1-based page numbers; boxes use normalized `[left, top, right,
bottom]` coordinates with a top-left origin. Nested fields and array fields can
cite several regions or pages. Plain text input keeps the existing value and
confidence contract because it has no visual coordinates.

Malformed, non-finite, out-of-range, reversed, and empty boxes are discarded, as
are page numbers outside the known document page count. Null values have no
visual evidence. The backend marks accepted boxes with `bbox_source: "model"`;
the viewer shows dashed boxes and labels them as model estimates. This validates
the shape of a box, not its spatial accuracy. If a model cannot locate a value,
it should return an empty evidence array. Source bytes are used only in memory
and are not duplicated in the persisted parser metadata.

This mode requires a model that supports the source file type. Unsupported
adapters and missing credentials fail explicitly. Tests mock provider responses;
real-world spatial accuracy has not been benchmarked.
