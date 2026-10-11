# Document validation and processing

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This package converts accepted document bytes into source-labelled text sections and chunks. The [API](../../apps/api/README.md) uses its byte validation before storage; the [worker](../../apps/worker/README.md) uses scanning, isolated parsing and chunking during ingestion.

## Main files

| File                                             | Responsibility                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/validate.ts](src/validate.ts)               | Filename/MIME/type checks, 25 MiB upload limit, PDF/Office signatures, bounded Office archive inspection and UTF-8 CSV validation.                   |
| [src/scanner.ts](src/scanner.ts)                 | `MalwareScanner` interface and ClamAV `ClamScanner` adapter.                                                                                         |
| [src/parsers.ts](src/parsers.ts)                 | Format-specific extraction and normalization, with PDF page, DOCX heading, or worksheet/row provenance.                                              |
| [src/isolated-parser.ts](src/isolated-parser.ts) | Starts a parser worker thread with a 256 MiB old-generation heap limit and five-minute deadline; translates parser failures into application errors. |
| [src/parse-task.ts](src/parse-task.ts)           | Worker-thread entry point calling the parser and returning sections or an error code.                                                                |
| [src/chunk.ts](src/chunk.ts)                     | `chunkSections()` uses `cl100k_base` tokens, paragraph packing, default 650-token size/90-token overlap, chunk hashes and source metadata.           |

## Extraction behavior

- PDF uses `pdfinfo` and per-page `pdftotext -layout`. A page with fewer than 30 extracted characters falls back to Poppler image rendering and English Tesseract OCR. PDFs are limited to 100 pages.
- DOCX uses Mammoth with external-file access disabled, then Cheerio to collect headings, prose and header-labelled table rows.
- XLSX uses ExcelJS to emit header-labelled rows and retain worksheet/row positions. Formula cached results are read; formulas are not recalculated.
- CSV uses strict UTF-8 record parsing and repeats column headers for each data row.

Text is normalized and bounded before chunking. Returned chunks contain text, SHA-256, token count and provenance. Table rows stay intact; an oversized table row fails instead of being split. Sections can yield chunks much smaller than 650 tokens.

## Boundaries and prerequisites

Poppler and Tesseract are external tools supplied by the host setup or Docker image; ClamAV is a separate service. The parser thread limits JavaScript heap/time but is not a full OS security sandbox. Byte checks and scanning are layered defenses, not a proof that arbitrary files are harmless.

PDF extraction is not a general layout-aware table reconstruction system. A mixed scanned/selectable page may have enough text to avoid OCR. Additional column/paragraph recovery happens later in [chat context construction](../chat/README.md). This package does not create embeddings or write database chunks; [ingestion](../ingestion/README.md) owns those steps.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
