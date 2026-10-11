# Web application

Reviewed against source on 2026-10-11. This is a code guide, not a live runtime check.

This application is the browser interface for the insurance policy assistant. It provides a platform overview, document management and advisor chat. It is a React application built with Vite; authorization and document processing are implemented in the backend.

## Main files

| File                                               | Responsibility                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/main.tsx](src/main.tsx)                       | React entry point and application shell, overview/readiness display and navigation to the document library and chat.                                  |
| [src/DocumentLibrary.tsx](src/DocumentLibrary.tsx) | Session handling, policy/document lists, administrator policy creation and upload, indexing status, document actions, source links and scoped search. |
| [src/AdvisorChat.tsx](src/AdvisorChat.tsx)         | Session handling, policy/date/version scope, optional second-policy comparison, conversation history, questions, SSE progress and cited answers.      |
| [src/styles.css](src/styles.css)                   | Shared application layout and visual styles.                                                                                                          |
| [vite.config.ts](vite.config.ts)                   | Vite/React configuration; development proxy for `/api` and `/health`; frontend build output.                                                          |
| [index.html](index.html)                           | HTML host for the React root.                                                                                                                         |

## How it is used

The browser calls the [API](../api/README.md) using relative URLs and session credentials. Document uploads follow reservation → byte upload → completion; completion starts asynchronous indexing in the [worker](../worker/README.md). The browser can inspect progress and search indexed policy terms.

Chat conversations retain their selected policy and as-of date, with optional explicit version or comparison scope. The UI reads SSE status, heartbeat, delta and completion events. Those answer deltas contain server-validated text; raw provider tokens are buffered in the backend. Citation links open authorized original document versions.

The frontend does not hold the embedding model, parser, vector database or grounding rules. Hiding an administrator control does not authorize an operation; the API checks identity and role on its own.

## Development and build

Run `npm run dev:web` from the repository root. Vite binds to `127.0.0.1:5173` and proxies API/health requests to `127.0.0.1:3000`. `npm run build` also generates this app's static assets in `apps/web/dist`.

Native host and Docker profiles have different serving arrangements. Use the [root runbook](../../README.md) for their startup steps; edit `src/`, not generated `dist/` assets.

## Project context

[Project wiki](../../wiki/index.md) · [Architecture](../../wiki/topics/architecture.md) · [Detailed walkthrough](../../docs/project-walkthrough.md)
