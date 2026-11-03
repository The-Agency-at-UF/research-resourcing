# Hosting the Slack app on Lambda

The Slack app is used a few times a semester, so it runs on demand instead of on an always-on server. Two Lambda functions in the `research-resourcing-pilot` stack (us-east-2) serve it:

- **Receiver** (`SlackReceiverFunction`, public Function URL): Slack's request URL for slash commands and interactivity. Bolt rejects any request without a valid Slack signature or older than five minutes. It acknowledges within Slack's three-second limit, opens or replaces a loading view, and invokes the worker asynchronously. It has no database access. `/resource-demo` runs entirely here; its Gemini option shows the labelled factual template because hosted mode has no Gemini key.
- **Worker** (`SlackWorkerFunction`, private): runs one pilot job (the same `runPilotJob` code the local bot runs inline), replaces the loading view with the result, then sends notices and refreshes the HQ message. Async retries are disabled so a job never runs twice.

Request URL (stack output `SlackRequestUrl`): `https://n2a5agvdeg35cldwmv6eo72o3u0zmavm.lambda-url.us-east-2.on.aws/`

Cost at this usage is effectively zero (Lambda requests, DynamoDB on-demand, 30-day log retention). Each first use after a quiet period has a cold start of roughly 0.6 s per function, so the result appears about a second later than on a warm function.

## One-time setup (operator)

1. **Store the secrets as SSM SecureString parameters.** They are read at cold start and never placed in environment variables. The bot token is the existing `xoxb-` token; the signing secret is under the Slack app's **Basic Information > App Credentials**.

   ```bash
   aws ssm put-parameter --profile research-resourcing-dev --region us-east-2 --type SecureString --name /research-resourcing/pilot/SLACK_BOT_TOKEN --value "$(grep '^SLACK_BOT_TOKEN=' .env.pilot | cut -d= -f2-)"
   read -rs SECRET && aws ssm put-parameter --profile research-resourcing-dev --region us-east-2 --type SecureString --name /research-resourcing/pilot/SLACK_SIGNING_SECRET --value "$SECRET"; unset SECRET
   ```

2. **Point the Slack app at the request URL.** In the app's **App Manifest** page, paste `infra/slack-manifest.hosted.json` (Socket Mode off; commands and interactivity use the URL), save, and reinstall if Slack asks. The app-level `xapp-` token is not used in this mode.

3. **Optional notices and HQ:** redeploy with `PilotNotify` (comma-separated Slack IDs) and `PilotHqChannel` parameter overrides, and invite the bot to that channel.

Slack sends requests either to Socket Mode or to the URL, never both. To develop locally again, paste `infra/slack-manifest.json` back and run `npm run slack:pilot`.

## Deploying changes

```bash
npm run build:lambda && npm run build:hosted
sam deploy --template-file infra/template.yaml --stack-name research-resourcing-pilot --profile research-resourcing-dev --region us-east-2 \
  --resolve-s3 --capabilities CAPABILITY_IAM --no-execute-changeset \
  --parameter-overrides PilotOperatorArn=<existing Research SSO role ARN> [PilotNamespace=… PilotNotify=… PilotHqChannel=…]
```

Review the change set, then execute it. Bundles are written to `dist/slack-lambda/` because `tsc` emits `src/hosted` to `dist/hosted`, and Lambda would load that unbundled `.js` first.

## Troubleshooting

Logs: `/aws/lambda/<function name>` for each function (30-day retention).

| Symptom | Cause |
|---|---|
| Slack says the command failed; receiver log shows `Missing SSM parameters` | Step 1 not done |
| HTTP 401 in the receiver log | Wrong signing secret, or a clock-skewed or replayed request |
| Loading view never changes | Worker failed; check its log. A view shows "could not be started" if the invocation itself failed |
| Worker log: `not running in the Research Resourcing account` | Deployed to the wrong account; the worker refuses to run |
