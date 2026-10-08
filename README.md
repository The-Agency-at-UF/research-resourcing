# Research Resourcing

A research staffing prototype based on the Resourcing Agent Brief: filter eligibility, rank researchers with configurable criteria, retain up to five candidates, and display two or three recommendations to managers.

## Run locally

Requires Node.js 24 and npm. All fixtures are fictional. No service credentials are needed for scoring.

```bash
npm ci
npm run demo
```

The CLI displays three recommendations and retains the top five with scores, explanations, configuration, exclusions, and warnings in ignored `artifacts/recommendation-run.json`. Manager text is saved to `artifacts/manager-view.txt`.

```bash
npm run demo -- fixtures/request-no-match.json
npm run typecheck
npm test
npm run build
npm run build:lambda
```

Run `npm run demo` again after the no-match example to restore the standard output. These local artifacts are not a durable production audit database.

## Configure ranking

Edit `config/scoring.json`: bandwidth 50%, skills 20%, experience 10%, interests 8%, account load 7%, industry 5%. Weights must sum to 1 and bandwidth must be the largest individual weight. Display count may be 2 or 3; retention is 5.

These are proposed pilot defaults. Review [scoring assumptions](docs/scoring.md) with research managers before using live data. Multiple identical openings share one shortlist; no researcher is automatically assigned.

## Connect services

[Access setup](docs/access-setup.md) covers Microsoft app registration, AWS SSO, and future model access. Draft admin requests are included and have not been sent.

```bash
cp .env.example .env
npm run access:check
```

The checker reports configuration presence only. Once the relevant permissions and credentials are configured:

```bash
npm run microsoft:check
```

The Microsoft helper verifies delegated sign-in and a OneDrive read. Slack request handling is a separate change. Optional model explanations are available through the Gemini CLI below.

## Structure

```text
config/scoring.json          Pilot scoring policy
fixtures/                    Fictional input data
src/recommendations/         Validation, eligibility, ranking, explanations
src/demo.ts                  Local demo and retained audit output
src/lambda.ts                Direct-invoke scoring handler
src/integrations/dynamodb.ts Optional audit persistence
src/scripts/                 Access and sign-in helpers
tests/                       Business rules and integration checks
infra/                       Undeployed AWS SAM template
```

## Scope

This phase implements scoring and technology/access scaffolding. Live Excel parsing/sync, date-aware capacity, manager authorization, approvals, verified updates to both Excel datasets, operations notifications, and Slack Canvas updates remain future work. Eligibility must be rechecked against fresh data before saving approved assignments; partial Excel updates must be reconciled.

See [technology notes](docs/tech-stack.md) for working features versus prepared integration pieces. Gemini is optional for CLI explanations and never determines scores. Fine-tuning is not required.

## Optional Gemini explanations

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the ignored `.env`, then run `npm run demo:gemini`. Gemini selects which verified facts to emphasize; code validates and renders those facts. Scores, ordering, warnings, and manager approval remain under application control. Invalid output or provider failure uses the full factual-template fallback. See [system instructions and guardrails](docs/gemini-guardrails.md). This CLI does not post to Slack or update Excel.
