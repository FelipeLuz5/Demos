# Optional connected edition

Recruiters can evaluate the complete offline demonstration with `npm start`. This page describes the additional runtime dependencies for the connected source included in this repository. No live provider call is needed to inspect the code or run the normal test suite.

## Start explicitly

```sh
npm run start:connected
```

Open http://127.0.0.1:3211. Use `npm.cmd` instead in PowerShell if script execution policy requires it. Connected mode uses `data/workflow.sqlite`, separately from the portfolio's fictional review history. Both are excluded from Git.

## Model extraction

The current adapter expects Windows, WSL2 and an independently configured OpenClaw gateway with a dedicated `workflow-extractor` agent, appropriate model authentication and tools denied. This repository does not install that runtime, provide an account or copy the author's assistant configuration.

The adapter's defaults and process contract are in `src/model.js`. `FDE_OPENCLAW_DISTRO`, `FDE_OPENCLAW_USER`, `FDE_OPENCLAW_AGENT` and `FDE_OPENCLAW_THINKING` allow local runtime selection. The application creates a fresh workflow session and attempts to remove it and its temporary prompt after extraction. An extraction or cleanup failure is surfaced rather than silently retried.

Upload a permitted `.txt` or `.json` transcript, confirm the meeting details and enter a reviewer. Each extraction requires two fresh confirmations: permission to process the transcript and permission to use the configured subscription allowance. Failed extraction does not save a review. Arbitrary transcripts cannot be processed in offline mode.

For a fictional connected smoke test, choose **New review** and fill the form directly:

- Meeting title: `Fictional Northstar website`
- Meeting start: `2026-09-15T10:00:00Z`
- Reviewer: your name
- Client: `Northstar Studio`
- Transcript:

```text
Alex, Northstar Studio: We approve a website with a home page and a contact page.
Alex: It must work on mobile and use our existing brand colours.
Alex: We agree to website delivery on October 23, 2026.
```

Check both extraction confirmations and select **Extract and build review**. This is a real model call using your separately configured runtime, even though the transcript is fictional. Inspect the returned scope and quotations, select the website, confirm the evidence, and approve it. The connected screen has no offline scenario selector and does not load portfolio approvals.

## Google setup on Windows

1. In your own Google Cloud project, enable Drive, Docs and Calendar APIs and configure an appropriate consent audience. Create a Desktop OAuth client. Keep the downloaded client JSON outside this repository.
2. Run `node configure-google.cjs` or `setup-google.cmd`. Supply the local path to that client JSON when prompted.
3. Open the printed sign-in URL and complete your own account consent. The loopback callback checks OAuth state and PKCE.
4. Type `CREATE` separately when asked to create the private FDE Drive folder and the FDE Deliveries calendar. These are real cloud writes.
5. With the model prerequisites above configured, restart in connected mode and follow the fictional transcript smoke test above: fill the intake form, permit extraction, review the evidence and approve the website. Then use the separate **Send approved projects to Google** action. Inspect the resulting Doc and the 23 October deadline.

Setup requests `drive.file` and `calendar.app.created`. It creates its own destinations; arbitrary existing folders are not selected through a Picker. Credentials and setup progress are encrypted for the current Windows user under `data/private/` using DPAPI. The desktop setup is not portable to another Windows account or a Linux service.

The adapter also accepts `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID` and `GOOGLE_CALENDAR_ID` for explicitly managed environments. Never commit their values. Run `node configure-google.cjs --reconnect` under the same account when consent needs renewal.

Delivery creates one client folder per exact normalized client name, a native Doc per approved project and one all-day calendar event per agreed date. Undated projects create no event. Events do not add attendees, reminders or invitations. Later scope/date changes are not synchronized automatically.

If a write may have completed, use **Check Google delivery** to reconcile its receipt. Do not clear the database or credentials to retry an uncertain write. Interrupted setup also retains its intent; unresolved calendar creation may require supplying the existing calendar ID. Changed resources and duplicate matches require manual reconciliation.

## Fathom import

In connected mode, open **New review → Import from Fathom**. Supply your own personal API key through the local connection field. The adapter verifies access before encrypting the key in a separate DPAPI file, then lets you list meetings and import one selected full transcript.

API access and transcript availability depend on your account; the code does not purchase, upgrade or activate a trial. Check provider eligibility yourself. `FATHOM_API_KEY` is also supported for managed configuration. Import fills the intake form; it does not trigger extraction or delivery. Oversized transcripts fail visibly rather than being truncated. There is no unattended ingestion or webhook service.

## Evidence boundaries

The author's local checkpoint records one synthetic Google delivery with API readback and a repeated send reusing the same resource identities on 14 September. Private receipts and resource IDs are not distributed here. This publication did not repeat live delivery. Fathom account connection and a live transcript import remain unverified. See [verification](VERIFICATION.md).
