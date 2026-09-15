# Architecture and engineering choices

## Current project-brief path

| File | Responsibility |
|---|---|
| `src/server.js` | Loopback HTTP server, offline/connected mode, session token and explicit action routes |
| `src/demo-fixtures.js` | Authored fictional transcripts and saved extraction examples |
| `src/brief.js` | Input normalization, extraction schema, quotation/date validation, approval and approved artifact |
| `src/brief-model.js`, `src/model.js` | Structured prompt and optional isolated OpenClaw extraction invocation |
| `src/db.js` | SQLite reviews, decisions, audit events and delivery receipts |
| `src/workflow.js` | Run records and readable Markdown exports |
| `src/google.js` | Google Drive/Docs/Calendar adapter and output formatting |
| `src/google-delivery.js` | Approved-project integrity, client routing, receipt persistence and recovery |
| `src/google-auth.js`, `configure-google.cjs` | OAuth state/PKCE, refresh tokens, Windows encryption and destination setup |
| `src/fathom.js` | Selected meeting metadata/transcript import, pagination, bounded input and sanitized errors |
| `public/app.js`, `public/styles.css` | Compact project cards, closed evidence disclosures and explicit approval |

Node's built-in HTTP, crypto and SQLite modules keep the runtime dependency-free. Reviews stay in local SQLite; Google stores approved briefs and deadlines only after a separate send action.

## Why approval and delivery are separate

A correct extraction is still a proposal. Approval records a named person's selected project IDs against a specific review digest. Delivery checks that approved snapshot before doing anything externally. A later proposal is not silently substituted into an earlier approval.

Google delivery saves progress at each stage. An interrupted response can mean that a resource was created even though the caller saw an error. The workflow records that uncertainty and looks for the matching resource before continuing. It does not blindly repeat creation. Identity mismatches, moved folders or duplicate matches stop for reconciliation.

## Portfolio boundary

`createApp()` defaults to portfolio mode. It uses the current brief validator and reviewer UI with saved fictional extractions. External HTTP actions are rejected even if credentials exist. Google/Fathom configuration is not loaded in this mode. The default portfolio database is `data/portfolio.sqlite`; the explicitly selected connected edition uses `data/workflow.sqlite`.

`npm run start:connected` enables the implemented connectors and live extraction routes. Connected HTTP tests explicitly opt into that mode and inject mock providers. The repository includes no private provider accounts or preconfigured assistant runtime.

## Validation limits

Literal quotation checks establish that cited text exists. They do not prove that every paraphrased description is semantically correct or that the client intended the model's interpretation. The reviewer remains responsible for the whole brief. Missing deadlines stay unspecified; internal task dates must not become project delivery dates.

The app is loopback-only and single-user. Source/review hashes detect inconsistent snapshots within this workflow; they are not a tamper-proof external audit service. There is no multi-user authentication or internet deployment configuration.

## Historical components

`src/core.js`, `src/fixtures.js`, `src/task-review.js` and `src/clarification.js` retain the earlier task-review path and regressions. `src/notion*.js` and their tests preserve the former delivery implementation. The active server returns HTTP 410 for Notion writes in connected mode. Historical records remain readable; this is not an active Notion integration.

## Relationship to the local application

This edition takes its business logic, integrations and compact review interface from the local application on 15 September 2026. Portfolio-specific changes add safe defaults, fictional project scenarios, a separate database, a distinct default port and reviewer-oriented documentation. Private runtime records and machine-specific setup are not copied. See [source provenance](SOURCE_SYNC.json) for source file hashes and adapted files.
