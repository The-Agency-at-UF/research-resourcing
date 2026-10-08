# Technology setup

| Layer | Choice | State |
|---|---|---|
| Runtime | Node.js 24, TypeScript | Configured: strict checking, lockfile, `.nvmrc`, CI |
| Validation | Zod | Requests, config, and researchers validated |
| Source data | Maintained Excel in Microsoft 365 | Real files pending; fictional JSON fixtures provided |
| Excel parsing | ExcelJS | Installed and smoke tested; column mapping pending |
| Microsoft authentication | MSAL Node and Microsoft Graph | Delegated sign-in diagnostic ready; tenant/app access pending |
| Ranking | Pure TypeScript weighted scoring | Working: five retained, two or three displayed |
| Slack | Planned Bolt JS Socket Mode interface | Separate change; not included in this foundation |
| Compute | AWS Lambda Node.js 24 | Direct-invoke handler and bundle ready; not deployed |
| Storage | DynamoDB | Optional transaction adapter and undeployed SAM run/result tables |
| Explanations | Factual templates; opt-in Gemini fact selection | CLI adapter with system instructions, strict validation, and fallback |

Node 24 is supported by [AWS Lambda](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html). Use the same major locally and in CI. Roger's system Node was 25.9.0; verification runs with bundled Node 24 without changing that installation.

The source diagram proposes OpenAI. Roger already has Gemini access, so an opt-in Gemini adapter selects verified facts while scoring remains independent of any model. Agree on the provider substitution with the Dev team before integration. An OpenAI account is not required for this phase.

The SAM template includes scoring and recommendation audit storage only. Managers, Researchers, Accounts, Assignments, and ScoringWeights from the complete diagram belong to later data/approval work. The direct handler does not automatically call persistence and has no DynamoDB access policy yet. Connect through a trusted service and add narrowly scoped table permissions when enabling persistence. The CLI already retains the top five locally in `artifacts/recommendation-run.json`.

The planned Slack Socket Mode demo needs a long-running process. Production Lambda would need an HTTPS receiver with signature verification and prompt acknowledgement, or a separately hosted persistent Socket Mode process.

## Fine-tuning

Explicit staffing rules and weighted ranking do not need fine-tuning. Evaluate manager acceptance, capacity violations, ranking usefulness, and request-to-approval time first. The opt-in Gemini adapter selects calculated facts; invalid output or API failure uses the full factual-template fallback. See [Gemini guardrails](gemini-guardrails.md).

[Bedrock fine-tuning](https://docs.aws.amazon.com/bedrock/latest/userguide/custom-model-fine-tuning.html) involves training data, customization, and evaluation. Consider it only after a measured language-task failure persists after better prompts and factual inputs, and reviewed training examples plus held-out evaluation are available. It cannot replace fresh Excel data, capacity rules, or manager approval.

## Dependencies

ExcelJS 4.4 uses UUID v4 via an older UUID dependency. A scoped npm override selects compatible UUID 11.x to address the current npm advisory. A test roundtrips an in-memory workbook with conditional formatting to exercise that UUID path.
