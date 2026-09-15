# FDE Meeting Review

**Turn a client meeting into project briefs a person can inspect, approve and trace back to the source.**

A working personal portfolio project by **Felipe Marques Luz**, built with AI coding assistance. The application combines structured extraction, deterministic validation, human approval and recoverable delivery. This edition reflects the project-brief workflow as of **15 September 2026**.

[Verification](docs/VERIFICATION.md) · [Architecture](docs/ARCHITECTURE.md) · [Connected edition](docs/CONNECTED.md) · [What changed](CHANGELOG.md)

## Try it in five minutes

Use **Windows with Node.js 24 or later**. Download this repository with **Code → Download ZIP** and extract it, or clone it. Open a terminal in the repository folder:

```sh
npm test
npm start
```

No package installation, API key, subscription or Docker is needed for the demo. In PowerShell, if execution policy blocks `npm.ps1`, use `npm.cmd test` and `npm.cmd start` instead. No policy change is needed.

Open **http://127.0.0.1:3211** and select **Start a review**.

1. Choose **Website + an undecided catalogue**, enter your reviewer name and build the review.
2. Open **View source** to inspect the exact quotations. Select the website; leave the unagreed catalogue unselected.
3. Confirm your evidence review and click **Approve selected**.
4. Open **Downloads & history**. Download the Markdown brief or structured JSON. Only the website is approved.
5. Try **Portuguese brief without a deadline**: the missing date stays unspecified. Try **Invalid evidence**: validation rejects the extraction before saving a review.

The transcripts and extraction results are authored fictional examples. Extraction is prerecorded; validation, approval, SQLite persistence and export execute for real. The demo ignores configured external connections and rejects live extraction and delivery requests. Stop the server with **Ctrl+C**. To use a different port, set `FDE_WORKFLOW_PORT` before starting.

## The problem and the design

Meeting transcripts mix agreed scope, possible projects, requirements and incomplete dates. Turning all of that directly into work records can create commitments nobody actually made.

This workflow keeps the source attached to the proposed work. A reviewer chooses which projects to approve, checks quotations and records a final decision. A label such as **Confirmed proposals** describes the extraction's assessment; it is never human approval.

| Capability | What to inspect |
|---|---|
| Project briefs | Deliverables, requirements and agreed project delivery dates; missing dates remain empty |
| Evidence checks | Literal quotations, numbered source lines, strict extraction schema and date support |
| Human control | Explicit project selection, evidence confirmation, named reviewer and one final decision |
| Record integrity | Source/review hashes, approval expiry and local audit events |
| Useful output | Markdown briefs and JSON retaining structured evidence and approval |
| Google delivery | In connected mode: client folders, native Docs and all-day deadline events |
| Recovery | Persisted receipts, identity checks and reconciliation of uncertain cloud writes |
| Transcript intake | Local text/JSON upload; optional selected Fathom meeting import |

## From demonstration to connected workflow

The repository includes the current Google and Fathom adapters and their mocked tests. **`npm start` runs the offline portfolio.** The explicitly selected connected edition uses the same review logic and adds transcript extraction and external delivery:

```mermaid
flowchart LR
    A[Transcript upload or selected Fathom meeting] --> B[Structured extraction]
    B --> C[Schema and evidence validation]
    C --> D[Human project selection and approval]
    D --> E[Local approved brief]
    E --> F[Separate explicit Google send]
    F --> G[Client folder and Google Doc]
    G --> H[Calendar event if date agreed]
    F --> I[Persisted receipts and recovery]
```

Google delivery does not share files, invite attendees or send notification emails. Fathom import does not start extraction automatically. Connected mode needs your own separately configured services; see [setup and limitations](docs/CONNECTED.md). The default demo requires none of them.

## My contribution

I defined the workflow requirements, evidence rules, approval boundaries, exception handling and reviewer experience. I directed the transition from an earlier n8n prototype to a standalone local application, then from task lists to client project briefs and Google delivery.

AI coding tools assisted with implementation, tests, documentation and independent code review. I do not present this as unaided engineering. The project demonstrates business-process design, requirements translation, API integration and evidence-based verification, complementing my Airbus FP&A experience in planning, forecasting and reporting automation.

## Verification and scope

**95 automated tests passed; one optional Windows credential-encryption test was skipped** in the 15 September local check. Tests exercise both offline behavior and connected components with mocked external responses. See [the verification record](docs/VERIFICATION.md) for exact limits.

This is a single-user local application and personal portfolio, not a paid client deployment or a production-certified service. No customer adoption, quantified time savings or production extraction accuracy is claimed. Browser visual testing for this update remains pending. Credentials, client files, assistant configuration, conversations and runtime databases are excluded from the repository.

**Author:** Felipe Marques Luz · [LinkedIn](https://www.linkedin.com/in/felipe-luz-b9656b195/)
