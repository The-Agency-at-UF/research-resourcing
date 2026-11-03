# Dated staffing pilot

This is a fictional-data pilot. DynamoDB is the source of truth for these test assignments. The bot runs locally using Slack Socket Mode; it does not update Excel, allocate real researchers, or expose an HTTP endpoint. `/resource-demo` remains the original undated sample; `/resource-pilot` uses the separate dated model.

## Run

Use Node 24 and `npm ci`. Copy the non-secret configuration names below into an ignored, permission-0600 `.env.pilot`, together with the existing Slack bot/app tokens. Use stack outputs for the workflow table and restricted role. Do not commit credentials.

```dotenv
AWS_PROFILE=research-resourcing-pilot
AWS_REGION=us-east-2
PILOT_AWS_ACCOUNT_ID=726964604716
WORKFLOW_TABLE=<WorkflowTable stack output>
PILOT_NAMESPACE=fictional-v1
SLACK_TEAM_ID=TB67278DB
SLACK_BOT_TOKEN=<existing bot token>
SLACK_APP_TOKEN=<current Socket Mode token>
```

Configure `research-resourcing-dev` for the dedicated Research account through Agency SSO. Configure `research-resourcing-pilot` with `source_profile=research-resourcing-dev`, the `PilotClientRoleArn` stack output as `role_arn`, and `region=us-east-2`. Runtime and seed commands verify the account through STS and refuse Studio Stack. No long-lived AWS credentials are stored.

```bash
aws sso login --profile research-resourcing-dev
npm run pilot:seed
npm run slack:pilot
```

Seeding an initialized namespace fails, including concurrent repeated seeds. Never use a new namespace as an accidental replacement for existing work. Integration tests deliberately create a unique `integration-<uuid>` namespace and retain their records for inspection. The shared namespace is `fictional-v1`.

Register `/resource-pilot` from `infra/slack-manifest.json` in the existing app. It needs the same `commands` and `chat:write` scopes, Socket Mode, and interactivity. No new channel history permissions are needed. Slack rotating access tokens still need renewal as described in `slack-demo.md`.

## Manager flow

The pilot seed enables Patricia, Camila, and Roger using their exact Agency Slack IDs. These pilot permissions must never be treated as a production allowlist. Each service operation checks the workspace and an enabled manager record. The final transaction also checks the manager version so a revoked permission cannot race an approval.

1. Run `/resource-pilot`, select a fictional account, dates, and staffing requirements.
2. Review two or three recommendations. Select one to five candidates from the retained shortlist, bounded by the remaining openings, or choose to decline remaining openings.
3. Review the selected researchers, inclusive dates, weekly hours, and minimum remaining capacity. Selection makes no reservation.
4. Confirm. Success explicitly means test assignments saved in DynamoDB. If any reviewed record changed, nothing is saved: reload the request and review again.
5. Use `/resource-pilot list` or `/resource-pilot <request-id>` to resume. Filled and declined requests remain readable. Partial requests require a fresh shortlist for another batch.

All UI results are private modals. Database operations happen after Slack acknowledgement. User-entered content is rendered as plain text; the pilot does not call Gemini.

## Capacity semantics

Dates are real `YYYY-MM-DD` calendar dates with inclusive endpoints, independent of time zones and daylight-saving transitions. Existing commitments reserve their full weekly hours on each date in their range; partial weeks are not prorated. Backdated fictional requests are allowed for reproducible scenarios.

The evaluator divides the requested period at assignment starts and at the day after assignment ends. Every resulting interval must fit the requested hours and simultaneous distinct-account limit. Availability must cover the entire requested range. Cancelled assignments consume nothing; overlapping active assignments sum. Existing same-account work excludes a researcher only during an overlap. No snapshot committed-hours/account totals are added to the schedule.

Ranking uses minimum free weekly hours and maximum simultaneous account count across the period. Skills, experience, activity, configurable weights, five retained/two or three displayed, and deterministic tie ordering remain in force. Rejection reasons include the limiting dates. Dated researchers reject missing schedules and legacy total fields rather than guessing.

## Persistence and transaction invariants

The workflow table has `pk=PILOT#<namespace>` and typed `sk` prefixes: `RESEARCHER#`, `ACCOUNT#`, `MANAGER#`, `REQUEST#`, `RUN#`, `REVIEW#`, `APPROVAL#`, `DECLINE#`, `CONFIG`, and `SEED`. Each item has a positive version and typed application data. Researcher items contain their complete profile and schedule; historical growth is bounded by a conservative 350 KB application guard before DynamoDB's item limit. Archival requires a separate versioned migration.

Recommendations and reviews are persisted before their modal appears. Review IDs are server-generated approval IDs, tied to the approving actor and immutable selected candidates. The approval path rereads manager, request, configuration, prior approval, and selected researcher rows using a transactional read. It reruns eligibility and requires the versions seen during review to match.

One conditional transaction replaces the selected researcher schedules and request progress and creates the immutable approval record. The same transaction checks permission, configuration, and review versions. Every application schedule or policy edit must increment its checked version. A conflicting batch changes nothing, including its other selected researchers. A retry with an already committed approval ID returns the recorded result, including when the first commit's network response was lost. No automatic stale-review approval is attempted.

The original two recommendation audit tables remain in the SAM stack. Dated workflow runs and decisions are self-contained in the workflow table so their state transitions can be committed together. The original direct-invoke scoring Lambda remains separate and does not acquire workflow-write permissions.

## Relation to the FigJam table design

The FigJam "DynamoDB Tables" page proposes seven tables. The pilot keeps the same entities in one workflow table (`pk=PILOT#<namespace>`, typed `sk` prefixes) so that an approval can check and write everything it depends on in a single DynamoDB transaction, which is what prevents two managers from overbooking the same researcher.

| FigJam table | Pilot item | Difference |
|---|---|---|
| Managers | `MANAGER#<slack user id>` | Keyed by Slack user ID for authorization; profile fields not stored |
| Researchers (nested skills, industries) | `RESEARCHER#<id>` | Same nesting; also holds the assignment schedule and availability window |
| Assignments (PK researcher_id, SK account_id) | `assignments[]` inside the researcher item | Embedded so capacity checks and new assignments commit atomically with the version check; carries dates, weekly load, and status |
| Accounts (nested required skills) | `ACCOUNT#<id>` | Requirements live on each staffing request instead |
| ScoringWeights | `CONFIG` | Single versioned policy |
| RecommendationRuns | `RUN#<id>` and `REQUEST#<id>` | Requests are separate so partial batches and declines can be tracked |
| RecommendationResults + approval record | `REVIEW#<id>`, `APPROVAL#<id>`, `DECLINE#<id>` | Reviews are immutable and approvals idempotent |

Trade-offs: researcher items grow with assignment history (guarded at 350 KB; archival needs a migration), and querying "everyone on account X" means reading all researchers, which is fine at roughly 40 members. If cross-account reporting grows, add an assignments index or a projection table populated after each committed approval; the transaction boundary should stay as it is.

## Infrastructure and verification

`infra/template.yaml` retains all three tables on deletion/replacement and uses on-demand billing. The workflow table enables server-side encryption. `PilotClientRole` trusts only the supplied existing project operator role and allows reads, queries, conditional checks, and puts only on the workflow table. It cannot delete tables or records, change IAM, deploy stacks, or access Studio Stack. Deployment uses the separate operator profile.

```bash
npm run typecheck
npm test
npm run build
npm run build:lambda
sam validate --lint --template-file infra/template.yaml --region us-east-2
sam deploy --template-file infra/template.yaml --stack-name research-resourcing-pilot \
  --profile research-resourcing-dev --region us-east-2 --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides PilotOperatorArn=<existing Research SSO role ARN>
npm run test:pilot:aws
```

`infra/pilot.guard` checks retention, on-demand billing, workflow encryption, restricted role references, and absence of public ingress. It is a targeted baseline, not a full account security audit. Automated tests cover inclusive dates, overlaps, account limits, authorization, stale reviews, batch atomicity, duplicate callbacks, lost responses, decline, and restart. The AWS integration test exercises real DynamoDB transactions in a unique test namespace.

Watch local process errors and DynamoDB transaction conflicts/throttling during pilot use. No durable CloudTrail trail was configured in the Research account at initial inspection; standard event history is not durable audit retention. This change does not modify account-wide logging. Production launch, live workbook integration, hosting, and cancellation/edit workflows require separate work.
