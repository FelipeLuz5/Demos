# Verification

Local verification on 11 September 2026: Node.js test runner, Windows.

17 automated tests passed. Coverage includes valid approval and export, blocked project conflicts, exclusions and dependencies, review tampering, rejection and clarification, SQLite persistence, HTTP security headers, session-token checks, repeated decisions, consent handling, and mocked model-adapter responses. A portfolio-specific test verifies that even an explicitly permitted manual model request is rejected without creating a run.

The automated checks do not call a model or external destination. A browser smoke check also verified scenario selection, evidence review, and successful approval of PT05 with export links displayed. GitHub Actions is configured for Windows and Node.js 24; no hosted CI run is claimed before publication. Live extraction, production load, and multi-user deployment have not been verified for this portfolio edition.
