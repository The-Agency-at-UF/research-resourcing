# Slack development demo

1. Sign in to [Your Slack apps](https://api.slack.com/apps) using the account for The Agency.
2. Check whether the project already has an app. Otherwise choose Create New App > From a manifest, select the workspace, and paste `infra/slack-manifest.json`.
3. The manifest requests `commands` and `chat:write`, with no channel-history scopes. A workspace administrator may need to approve installation.
4. In Basic Information > App-Level Tokens, generate a token with `connections:write`. Put it in `.env` as `SLACK_APP_TOKEN`.
5. Install the app or submit for admin approval. Put the Bot User OAuth Token in `.env` as `SLACK_BOT_TOKEN`. Confirm `SLACK_TEAM_ID` matches your intended workspace; The Agency discovered here is `TB67278DB`.
6. Enable **Interactivity & Shortcuts** in the existing app's settings and save. Socket Mode handles delivery without a public request URL; the updated manifest also includes `settings.interactivity.is_enabled: true`. Keep the existing token-rotation setting: rotation cannot be disabled once enabled. The manifest omits that setting so it does not request a change.
7. Run `npm run slack:demo`. Run `/resource-demo` in a test conversation for the original ephemeral result, or `/resource-demo form` to enter fictional request details and see private modal results. Each successful run saves a local record with up to five retained candidates in ignored `artifacts/slack-runs/<run-id>.json`; only two or three appear to the requester. No assignments are made. Fixtures/config load at startup; restart after edits.

To test the optional Gemini connection, configure `GEMINI_API_KEY` and `GEMINI_MODEL`, restart the process, and run `/resource-demo ai`. It uses the fictional sample data, responds privately, and labels successful Gemini fact selection or template fallback. No new command registration or scope is required. See [Gemini guardrails](gemini-guardrails.md).

If app-level token rotation is enabled, store the access and refresh tokens locally as `SLACK_APP_TOKEN` and `SLACK_APP_REFRESH_TOKEN`. Rotating access tokens expire after 12 hours; this development script does not automatically refresh them yet. Renewal requires the Slack app client ID/secret and `oauth.v2.access`; each response's new access and refresh tokens must both replace the old pair. Do not print token responses. See [token rotation](https://docs.slack.dev/authentication/using-token-rotation/).

Approvals, production forms, Canvas updates, and live-data notifications are later work. Canvas may require additional scopes and plan support. The local script is a persistent Socket Mode process, not a Lambda HTTP receiver.

Sources: [manifest reference](https://docs.slack.dev/reference/app-manifest/), [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [view submissions](https://docs.slack.dev/tools/bolt-js/concepts/view-submissions/), [commands](https://docs.slack.dev/reference/scopes/commands/), [chat:write](https://docs.slack.dev/reference/scopes/chat.write/).
