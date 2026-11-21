# Local Slack setup

Production runs on Lambda ([hosting](hosting.md)). For development, the same `/resourcing` handlers run on your machine over Socket Mode.

1. Sign in to [Your Slack apps](https://api.slack.com/apps) with The Agency account and open the Research Resourcing app (formerly Staffing Recommendation Beta).
2. In **App Manifest**, paste `infra/slack-manifest.json` (Socket Mode on) and save. It requests `commands`, `chat:write`, and `files:read`, with no channel-history scopes. Reinstall when Slack asks; a workspace administrator may need to approve.
3. In **Basic Information > App-Level Tokens**, generate a token with `connections:write`.
4. Copy `.env.resourcing.example` to an ignored, permission-0600 `.env.resourcing`. Fill in the Bot User OAuth Token (`SLACK_BOT_TOKEN`), the app-level token (`SLACK_APP_TOKEN`), `SLACK_TEAM_ID` (`TB67278DB` for The Agency), and the AWS settings from [the workflow guide](resourcing.md#run).
5. Run `npm run slack` and use `/resourcing` in Slack.

Slack sends requests either to Socket Mode or to the hosted URL, never both. Paste `infra/slack-manifest.hosted.json` back when you finish.

If app-level token rotation is enabled, store the access and refresh tokens as `SLACK_APP_TOKEN` and `SLACK_APP_REFRESH_TOKEN`. Rotating access tokens expire after 12 hours, and this script does not refresh them. Renewal needs the app's client ID and secret and `oauth.v2.access`. Each response's new access and refresh tokens must both replace the old pair. Do not print token responses. See [token rotation](https://docs.slack.dev/authentication/using-token-rotation/).

Sources: [manifest reference](https://docs.slack.dev/reference/app-manifest/), [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [file input](https://docs.slack.dev/reference/block-kit/block-elements/file-input-element/).
