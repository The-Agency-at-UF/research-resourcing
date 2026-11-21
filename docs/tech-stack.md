# Technology setup

| Layer | Choice | State |
|---|---|---|
| Runtime | Node.js 24, TypeScript | Configured: strict checking, lockfile, `.nvmrc`, CI |
| Validation | Zod | Requests, config, and researchers validated |
| Source data | Maintained Excel in Microsoft 365 | Real files pending; fictional JSON fixtures provided |
| Excel parsing | ExcelJS | Installed and smoke tested; column mapping pending |
| Microsoft authentication | MSAL Node and Microsoft Graph | Delegated sign-in diagnostic ready; tenant/app access pending |
| Ranking | Pure TypeScript weighted scoring | Working: five retained, two or three displayed |
| Slack | Bolt JS local Socket Mode | Fixed demo, request form, opt-in Gemini sample, private results, and local run records; see [setup](slack-demo.md) |
| Compute | AWS Lambda Node.js 24 | Deployed: direct-invoke scoring, plus the Slack receiver (signed Function URL) and private worker; see [hosting](hosting.md) |
| Storage | DynamoDB | Versioned dated staffing pilot and atomic batch approvals; separate legacy audit adapter; see [pilot setup](pilot.md) |
| Explanations | Factual templates; opt-in Gemini fact selection | CLI and Slack adapter with system instructions, strict validation, and labeled fallback |

Node 24 is supported by [AWS Lambda](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html). Use the same major locally and in CI. Roger's system Node was 25.9.0; verification runs with bundled Node 24 without changing that installation.

The source diagram proposes OpenAI. Roger already has Gemini access, so an opt-in Gemini adapter selects verified facts while scoring remains independent of any model. Agree on the provider substitution with the Dev team before integration. An OpenAI account is not required for this phase.

The SAM template includes scoring, the original recommendation audit tables, and a fictional workflow table for dated researcher schedules, managers, accounts, requests, policies, and decisions. The local pilot uses a restricted assumed role for this workflow table. The direct scoring handler remains separate and does not automatically call persistence or acquire workflow permissions. The legacy CLI retains the top five locally in `artifacts/recommendation-run.json`.

Slack runs two ways from the same handlers: locally through Socket Mode for development (`npm run slack:pilot`), or hosted on Lambda through a signed Function URL receiver and an asynchronous worker, which suits a tool used a few times a semester. See [hosting](hosting.md).

## Fine-tuning

Explicit staffing rules and weighted ranking do not need fine-tuning. Evaluate manager acceptance, capacity violations, ranking usefulness, and request-to-approval time first. The opt-in Gemini adapter selects calculated facts; invalid output or API failure uses the full factual-template fallback. See [Gemini guardrails](gemini-guardrails.md).

[Bedrock fine-tuning](https://docs.aws.amazon.com/bedrock/latest/userguide/custom-model-fine-tuning.html) involves training data, customization, and evaluation. Consider it only after a measured language-task failure persists after better prompts and factual inputs, and reviewed training examples plus held-out evaluation are available. It cannot replace fresh Excel data, capacity rules, or manager approval.

## Dependencies

ExcelJS 4.4 uses UUID v4 via an older UUID dependency. A scoped npm override selects compatible UUID 11.x to address the current npm advisory. A test roundtrips an in-memory workbook with conditional formatting to exercise that UUID path.
