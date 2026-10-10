---
title: Document ingestion and versioning
type: topic
status: current
reviewed: 2026-10-10
---

# Document ingestion and versioning

1. ADMIN reserves immutable source metadata/version through upload-url; the returned upload location is an authenticated API PUT route.
2. Upload validates type, bytes, size/hash and reservation ownership. Originals are AES-256-GCM encrypted and immutable.
3. Complete-upload commits UPLOADED plus a durable PostgreSQL job; the notification outbox is transactional.
4. The worker claims a fenced lease, verifies/decrypts the source, scans with ClamAV, validates and parses.
5. Heading/row-aware chunks receive encrypted text/provenance, embeddings and a tenant-keyed keyword index. Only a complete generation is atomically activated as INDEXED.

These stages and recovery behavior are described in [the inspected walkthrough](../../docs/project-walkthrough.md) and implemented by [pipeline.ts](../../packages/ingestion/src/pipeline.ts). PostgreSQL SKIP LOCKED claims and lease heartbeats prevent a stale worker publishing over a replacement. Retries and embedding-batch reuse are bounded; SQS is only a wake-up hint.

| Format | Parsing and provenance                                                               |
| ------ | ------------------------------------------------------------------------------------ |
| PDF    | Poppler page extraction, English Tesseract fallback for low-text pages; page numbers |
| DOCX   | Mammoth/Cheerio headings, paragraphs and tables; section titles                      |
| XLSX   | ExcelJS header-labelled rows; sheets/row numbers, cached formula values              |
| CSV    | Strict UTF-8, first-row headers, row positions                                       |

Uploads are capped at 25 MiB; legacy DOC/XLS are rejected. Defaults use 650-token chunks with 90-token overlap; oversized table rows fail rather than split. Parser limits also bound pages, sheets, rows, archive expansion, extracted text and chunk counts. OCR/page and PDF layout heuristics have documented limits. [Parser/chunking details](../../docs/project-walkthrough.md).

Applicability uses effective dates, explicit supersession and optional historical version IDs, not upload order. Ambiguity requires clarification; a newer applicable unindexed version blocks obsolete fallback. Archiving retains bytes and removes eligibility; it does not automatically resurrect superseded versions. Model identity/dimensions must match semantic retrieval; [retrieval](retrieval-and-chat.md) explains keyword compatibility.

## Sources

- [Approved decisions and evidence/version rules](../../docs/phase-2-decisions.md)
- [Upload/version API contracts](../../docs/api-contracts.md)
- [Pipeline](../../packages/ingestion/src/pipeline.ts), [parsers](../../packages/document-processing/src/parsers.ts), [chunker](../../packages/document-processing/src/chunk.ts)

## Related

[Architecture](architecture.md) · [Security](security.md) · [Operations](operations.md)
