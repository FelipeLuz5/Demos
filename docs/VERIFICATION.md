# Verification — 15 September 2026

## Executed for this edition

- Environment: Windows, Node.js built-in test runner.
- Command: `npm.cmd test` (`node --test test/*.test.cjs`).
- Result: **95 passed, 0 failed, 1 skipped** across 96 tests.
- Skipped: optional Windows DPAPI encryption/decryption check, which requires an explicit opt-in under a loaded user profile.

The suite covers strict schemas and literal evidence, supported dates, selective approval, reviewer identity, expiry and snapshot integrity, SQLite persistence, local exports, session-token and Host checks, Google routing and uncertain-write recovery, OAuth state/PKCE and refresh, Fathom pagination/import, UI rendering and historical task/Notion regressions.

Portfolio HTTP tests verify the recruiter journey, invalid-evidence rejection before persistence, preserved missing dates, a single final decision and exclusion of unapproved scope from exports. They also verify that default mode ignores injected configured providers and rejects model calls, Fathom actions, Google sends, old Notion sends and draft-refinement requests.

External responses and model execution are mocked. Test success is not a claim of live account access, model accuracy, production readiness or security certification. GitHub Actions is configured to run the same suite on Windows/Node 24; a hosted result is only established by the repository's actual Actions run.

## Visual and manual limits

The browser tool reported no available browser for this update. Therefore no new browser screenshot, visual layout approval or browser interaction pass is claimed. Automated HTTP tests and JavaScript rendering tests passed; they are not a substitute for visual inspection.

## Historical connected evidence

The local development checkpoint records a synthetic Google Docs/Calendar delivery and API readback on 14 September, followed by reuse of the same resources on repeat delivery. This is one local synthetic case, not customer acceptance. Private receipts are excluded from this public repository. Fathom live connection/import remains pending.

## Independent review

The publication checkpoint is recorded after the bounded independent source review. The review examines the portfolio boundary, current workflow alignment, test evidence, documentation claims and public-file scope. It does not independently establish live integrations or browser behavior.
