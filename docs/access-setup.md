# Project access and setup

Prepared October 7, 2026. Account membership and application permissions are separate: opening Excel or using Slack does not grant the new application API access.

## Verified and reported access

| Service | Evidence | Next step |
|---|---|---|
| GitHub | RogerMcKenzie authenticated locally; repository admin/push permissions verified | Review implementation branch |
| Microsoft 365 | Roger confirms UF account; browser admin portal requires sign-in | UF Entra registration and approved Graph authentication |
| AWS | Roger supplied access portal; existing SSO config matches it and uses us-east-1; project account pending | Wait for Research Resourcing account and assigned role; then configure a dedicated profile |
| Gemini | Roger confirms existing API access | Confirm project ownership and approved usage before integrating |

The existing local AWS profile matches the supplied SSO portal, but its account/role has not been established as the Research Resourcing environment. A read-only identity check could not connect to AWS's SSO token endpoint. No cloud resources, workbook writes, application access grants, or outgoing messages were created.

## Local configuration

Use Node 24 (`nvm install 24` and `nvm use 24` if you use nvm), then:

```bash
npm ci
cp .env.example .env
npm run access:check
```

The checker reports configuration presence only, never credential values or verified permissions. Real values belong in ignored `.env` locally and the team's secret store for hosted deployments. Scoring needs no credentials.

## Microsoft 365 and UF app registration

First establish whether UF allows you to register an app. UF account access alone does not establish that permission.

1. Sign in to the [Entra admin center](https://entra.microsoft.com/), select the UF tenant, and locate App registrations. Ask UF IT/application administration for a project-owned single-tenant development app if you cannot register one.
2. The local diagnostic uses a public-client app. Record Directory (tenant) ID and Application (client) ID in `.env`. This diagnostic needs no client secret.
3. Ask the application administrator to configure Microsoft Graph delegated `Files.ReadWrite` and the required tenant consent. Enable Allow public client flows only if UF policies permit device-code sign-in. If blocked, use an IT-approved interactive flow instead.
4. Run `npm run microsoft:check` and complete the displayed Microsoft sign-in/MFA. Tokens stay in memory; the helper only checks a OneDrive read.
5. Once sheets arrive, record drive/item IDs, verify reads to both maintained files, and verify a controlled write on test copies before connecting approvals.

Graph's [Excel range-update API](https://learn.microsoft.com/en-us/graph/api/range-update?view=graph-rest-1.0) supports delegated `Files.ReadWrite` but **does not support application permissions**. A Lambda client secret does not remove that constraint. Agree with UF IT on production delegated authentication/token handling, or evaluate approved file download/edit/upload APIs with conflict checks. [Selected resource permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) must be evaluated for the exact chosen APIs; they do not enable unsupported app-only workbook APIs.

The local diagnostic's delegated scope can cover files accessible to the signed-in user, not just two workbooks. Review the requested access with the administrator before consent. Production authorization must fit the maintained files and write strategy. Two Excel writes are not made atomic by a DynamoDB transaction; partial updates need retries and reconciliation.

Sources: [app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app), [public-client/device flow](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration).

## AWS access portal / IAM Identity Center

Roger supplied the start URL privately; the portal sign-in and matching local SSO configuration identify the SSO region as `us-east-1`. Obtain the project account ID, permission-set role, and deployment region from the AWS owner. The SSO region is not necessarily the deployment region. Verify the account is intended for this project.

```bash
aws configure sso --profile research-resourcing-dev
aws sso login --profile research-resourcing-dev
aws sts get-caller-identity --profile research-resourcing-dev
```

Set `AWS_PROFILE=research-resourcing-dev` and the agreed `AWS_REGION` in `.env`. Identity verification confirms sign-in, not deployment privileges. Request a development permission set for the approved Lambda/DynamoDB stack, CloudWatch logs, CloudFormation/SAM packaging, and permission to pass only the approved execution role. The administrator can provide the execution role if your deployment role cannot create IAM roles. Runtime access and deployment access are distinct.

After confirming deployment scope and billing, install AWS SAM CLI if needed:

```bash
npm run build:lambda
sam validate --template-file infra/template.yaml
sam deploy --guided --template-file infra/template.yaml --profile research-resourcing-dev
```

Deployment creates chargeable resources and has not been run. The two DynamoDB tables retain data on stack deletion. Configure their output names when enabling the optional persistence adapter. Future Slack/Microsoft/Gemini credentials belong in the team's approved secret store.

Source: [AWS CLI SSO setup](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html).

## Gemini and model customization

Use the existing Gemini project if the team approves it; confirm billing/quota ownership. Set `GEMINI_API_KEY` in the ignored `.env`; the default `gemini-flash-latest` alias tracks Google's Flash releases. `GEMINI_MODEL` optionally pins a verified version for manual rollback. Run `npm run demo:gemini` for the opt-in CLI or `/resource-demo ai` with the local Slack bot running. Only fictional evidence is sent; the CLI makes no Slack writes and neither mode writes Excel. See [Gemini guardrails](gemini-guardrails.md). [Gemini keys](https://ai.google.dev/gemini-api/docs/api-key) are associated with a Google Cloud project and belong on the backend.

No fine-tuning permissions are needed now. Evaluate model customization only after a measured task failure, sufficient reviewed training examples, and held-out evaluation. See `docs/tech-stack.md`.

## Draft access requests (not sent)

**UF application administrator:**

> We're building a research staffing tool using two maintained UF Microsoft 365 Excel datasets. Could you provide a project-owned Entra development app, tenant/client IDs, and an approved Graph read/write authentication approach? The local diagnostic uses delegated Files.ReadWrite with public-client sign-in; workbook range updates do not support app-only access. We also need guidance on maintained file location and production token handling.

**AWS project owner:**

> Could you provide the project AWS access portal URL, SSO region, development account, permission-set role, and deployment region? We need an approved development role for Lambda, DynamoDB, logs, and CloudFormation/SAM deployment. The initial stack includes a direct-invoke scoring function and two audit tables; please confirm execution-role policy and billing before deployment.
