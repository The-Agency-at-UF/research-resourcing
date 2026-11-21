# Research Resourcing

Staffing recommendations and approvals for The Agency at UF's Research department, based on the Resourcing Agent Brief. Managers use `/resourcing` in Slack. The command filters eligible researchers and ranks them with configurable criteria. It shows two or three recommendations from a retained five, and saves manager-approved assignments with date-aware capacity and atomic checks.

- [Staffing workflow and approval rules](docs/resourcing.md): commands, the manager flow, assignment changes, workbook updates, metrics, and data model.
- [Workbook import](docs/workbook.md): reading the Research Resourcing workbook and the optional 1:1 profiles. Capacity is measured in account slots because the workbook has no hours.
- [Hosting](docs/hosting.md): the Slack app runs on demand in Lambda. [Local Slack setup](docs/slack-setup.md) covers development over Socket Mode.

## Run locally

Requires Node.js 24 and npm. Fixtures are fictional. No service credentials are needed for scoring.

```bash
npm ci
npm run demo                                   # CLI ranking on fictional fixtures
npm run workbook -- --sample --sample-profiles # ranking from the fictional workbook layout
npm run typecheck
npm test
npm run build
npm run build:hosted
```

The CLI demo displays three recommendations and keeps the top five, with scores, explanations, configuration, exclusions, and warnings, in ignored `artifacts/`. These local artifacts are not a durable audit record.

## Configure ranking

`config/scoring-workbook.json` holds the ranking weights for workbook data, and `config/scoring.json` holds them for the hours-based fixtures. Weights must sum to 1, and bandwidth must be the largest individual weight. Display count may be 2 or 3; retention is 5. Review [scoring assumptions](docs/scoring.md) with Research managers. Identical openings share one shortlist, and nobody is assigned without a manager's approval.

## Connect services

[Access setup](docs/access-setup.md) covers Microsoft app registration, AWS SSO, and model access. Draft admin requests are included and have not been sent.

```bash
cp .env.example .env
npm run access:check
npm run microsoft:check
```

## Structure

```text
config/                      Scoring policies, workbook settings and UF term dates
src/recommendations/         Validation, eligibility, ranking, explanations
src/resourcing/              Dated capacity, workflow service, DynamoDB store, imports, reports
src/workbook/                Workbook, 1:1 profile, and upload parsing
src/slack/                   /resourcing handlers and modals
src/hosted/                  Lambda receiver and worker
src/scripts/                 Seeding, metrics, access and sign-in helpers
tests/                       Business rules and integration checks
infra/                       AWS SAM template, guard rules, Slack manifests
```

## Scope

Assignments are saved in DynamoDB. They are not yet written back to the Excel workbook. Writing back, and reading the workbook automatically instead of uploading it, both need Microsoft Graph access from UF IT. See [technology notes](docs/tech-stack.md).

## Optional Gemini explanations

Set `GEMINI_API_KEY` in the ignored `.env` (default model: `gemini-flash-latest`), then run `npm run demo:gemini`. `GEMINI_MODEL` can override the default with a pinned ID. Gemini selects which verified facts to emphasize; code validates and renders them. Scores, ordering, warnings, and approval stay under application control. Invalid output or provider failures fall back to the full factual template. See [system instructions and guardrails](docs/gemini-guardrails.md). `/resourcing` does not call Gemini.
