# Local model timeout investigation — 8 October 2026

The latest failed chat was scoped to Max Life Insurance, conversation `0a7a65d8-8daf-4887-9e24-59f2af0c213d`, run `f293f664-f075-4048-b1ef-37d9a9c0f83c`, request `daa2f500-7406-4032-898e-f5a3eb22f050`.

The request started at 16:08:03 UTC and failed with MODEL_TIMEOUT after 184,755 ms. The model call had a 180,000 ms deadline. It was a single-policy chat, not a two-policy comparison. No messages were saved. Failed requests intentionally retain only a question fingerprint; the exact question cannot be recovered from the database.

Ollama began loading Qwen at 16:08:05 UTC, reported readiness at 16:09:20 (75 seconds later), then the API cancelled the model request at 16:11:05. Its logs showed only early prompt batches before cancellation. This was not a citation-validation rejection, tenant-access denial, or an inference that the user's question was too long.

Resource measurements during diagnosis:

- Docker VM: 4,108,828,672 bytes (about 3.8 GiB).
- VM swap: 1 GiB total, only about 17 MiB free.
- Host physical RAM: 8 GiB; host swap in use about 8 GiB.
- Ollama had both embedding and chat runners resident; roughly 1.75 GiB RSS.
- No cgroup OOM kill was recorded.

The observed loading delay and system-wide slowdown strongly indicate paging/resource contention. They do not establish question-length as the cause. Ollama in Docker on macOS also uses CPU inference; see [official FAQ](https://docs.ollama.com/faq).

Changes:

1. Compose loads at most one Ollama model at a time, so embeddings and chat do not remain resident together. This trades model-switching overhead for lower peak residency on this small VM.
2. The UI timeout message now names loading/generation and local resource checks instead of assuming a shorter question will help.
3. Model completion/timeout logs now include safe duration, token/frame counts and timeout budget, without question/evidence text.
4. A regression test verifies that a model stalled during loading produces MODEL_TIMEOUT once, without retries or partial answers.

The existing 180-second deadline remains bounded; it was not extended to hide resource problems. On this 8 GiB host, do not allocate all RAM to Docker. Closing memory-heavy applications or using native macOS Ollama with Metal can help; the latter is a separate local runtime configuration, not a cloud dependency. LocalStack/AWS are irrelevant to this failure.

Validation: lint, TypeScript checks and 61 unit tests passed. See `model-timeout-debug.json` if a representative same-policy request completed. Exact-question reproduction depends on the user supplying the question. The original failed run is retained.
