# Phase 4 — advanced retrieval, locally

The chat now uses hybrid retrieval, optional local reranking, bounded conversation topic memory, a LangGraph workflow and two-policy comparisons. All services remain local. No AWS or LocalStack deployment is included.

## Run and verify

```sh
npm ci
npm run setup
docker compose --env-file .env.development up -d --build --wait
# Upgrading existing Phase 2/3 documents: run once per tenant.
npm run db:keywords
npm run check
npm run test:integration
npm run test:advanced
```

`db:keywords` defaults to the generated `LOCAL_TENANT_ID`; pass another authorized tenant UUID after `--` to backfill its chunks. It uses the restricted application role, decrypts bounded batches and is idempotent. New ingestion generates the keyword index automatically. Existing embeddings and document content are preserved. A missing keyword index is exposed as `diagnostics.keywordReady=false`; semantic retrieval remains available while backfilling.

Open [localhost:8080](http://localhost:8080), choose **Advisor chat**, select a policy and optionally **Compare with**, set the effective date and create a conversation. Ask a policy question, then a follow-up such as “What about its limit?” Reopen the saved chat to inspect its history. A comparison uses applicable versions of both policies on the same date; explicit version selections are available only for single-policy chats. Ambiguous versions still require clarification.

## Retrieval

Both branches use tenant filters, forced PostgreSQL RLS, the applicable version set, active generation, embedding profile and scan checks. Each gathers at most 40 candidates, defaults to 20, and has stable ID tie-breaking. Semantic search uses pgvector cosine distance. Keyword search uses PostgreSQL GIN/tsvector and `ts_rank_cd`. The English normalizer retains clause identifiers and numbers, removes common stopwords and performs minimal plural normalization. This is not BM25 or a full English language stemmer.

Policy text remains encrypted. Keyword lexemes are tenant-keyed HMACs, including their normalization profile. SQL receives hashes and positions rather than plaintext terms. This blind index still exposes within-tenant frequency and positional patterns; it is not searchable encryption with a formal leakage proof. Encryption-key/profile changes require rebuilding this index and the existing encrypted data.

Reciprocal Rank Fusion combines the two lists with `k=60`, deduplicating by chunk ID. The optional `lexical-cosine-v1` reranker scores query-term coverage, cosine similarity and exact numeric identifiers over the bounded decrypted candidates. It is a deterministic heuristic, not a cross-encoder model or calibrated confidence score. The `Reranker` interface allows a future model adapter.

| Variable               | Default  | Purpose                                          |
| ---------------------- | -------- | ------------------------------------------------ |
| `RETRIEVAL_MODE`       | `hybrid` | Chat candidate retrieval: `hybrid` or `semantic` |
| `RETRIEVAL_RERANK`     | `true`   | Enable the local second-stage heuristic          |
| `RETRIEVAL_CANDIDATES` | `20`     | Candidates per branch, 10–40                     |
| `CHAT_TOP_K`           | `8`      | Final chunks offered to the context builder      |
| `CHAT_CONTEXT_TOKENS`  | `2000`   | Whole-chunk evidence budget per policy           |

`POST /api/v1/search` accepts `mode` (`semantic`, `keyword`, `hybrid`), `rerank`, `candidateK` and `topK`. Diagnostics report candidate counts, keyword readiness and reranker identity. To evaluate the pure semantic baseline, set `mode=semantic` and `rerank=false`.

## Conversation workflow and comparisons

LangGraph runs four bounded, non-looping stages: rewrite → retrieve → generate → validate. Cancellation propagates throughout. No external tracing, agent tools or remote graph/checkpoint service is configured. Graph state lasts only for the request. Durable chat state remains encrypted in PostgreSQL under owner-enforced RLS.

Memory is an extractive topic summary: at most six recent user questions and 400 tokens, with a resolved topic capped at 160 tokens. It never treats assistant answers as policy facts. A conservative, deterministic rewriter uses that topic for obvious follow-ups; an explicitly named new subject replaces it. A conservative lexical topic check rejects obvious subject mismatches before generation and after quote selection. Generic insurance/question words do not count as topic support. It can abstain on valid synonyms and does not establish full semantic relevance or qualification completeness. The generator receives the resolved query and freshly retrieved evidence, never an unbounded transcript. Successful turns save encrypted memory atomically with messages, citations and idempotency state. Failed/cancelled turns do not update memory. Older chats initialize memory from a bounded selection of owned user messages. This does not provide arbitrary reasoning over the full conversation or resolve every ambiguous pronoun. Redis memory caching is deferred to Phase 7.

`POST /api/v1/conversations` adds optional `comparisonPolicyId`. Both policy IDs must exist in the caller's tenant, be distinct, and have no explicit `versionIds`. Each policy runs its own retrieval/generation/validation workflow. Results are labelled by policy, with global citation numbers and policy-labelled citations. Different terms across policies are shown side by side rather than described as contradictory sources within one policy. Missing evidence for either policy is reported explicitly; the other policy's claims are never substituted. No recommendation or “better policy” conclusion is inferred.

Before publication, the service locks and rechecks both version snapshots in a stable policy-ID order. It atomically saves one completed comparison turn or a failure, preserving Phase 3's idempotency, source validity, strict ownership and streamed-publication boundaries. Comparison generation is sequential and can take longer; the API's 240-second request deadline and five-minute run lease still apply.

## Evaluation and limits

`npm run test:advanced` uploads two real synthetic PDFs and eight labelled CSV clause rows through ClamAV, parsing, Ollama embedding and pgvector indexing. It checks a direct answer, an anaphoric follow-up, missing evidence, a complete comparison, a partial comparison, an explicit new missing subject in a follow-up, preservation of that subject in a third turn, and saved history. It then evaluates eight labelled queries at K=3 for semantic-only, hybrid fusion and hybrid plus reranking, recording Recall, Precision, MRR and binary nDCG. Expected clause IDs come from the fixture, not model judgements. CI gates reranked hybrid Recall@3 ≥ 0.875 and MRR ≥ 0.75 on this small corpus.

Outputs and timings are saved to [phase-4-demo.json](phase-4-demo.json). These small synthetic regression checks do not establish production retrieval quality, broad groundedness, policy completeness or performance SLOs. Quote validation guarantees provenance and verbatim boundaries, not full semantic relevance. Harmless capitalization or an added leading article can be aligned to the original whole source clause; published quotes always use original source wording. Changed numbers, negations, conditions or incomplete clauses remain rejected. A narrow deterministic conflict check catches otherwise identical waiting-period clauses with different integer values and the same units in separate chunks; it preserves every qualifier and does not cover arbitrary semantic conflicts. Larger customer-reviewed query sets and model/reranker comparisons remain necessary before production. LocalStack validation remains a later step before AWS deployment.

## Primary implementation references

- [PostgreSQL 17 full-text query and ranking controls](https://www.postgresql.org/docs/17/textsearch-controls.html).
- [LangGraph JavaScript graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api).
