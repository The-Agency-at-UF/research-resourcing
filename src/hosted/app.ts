import { App, AwsLambdaReceiver } from '@slack/bolt';
import config from '../../config/scoring.json' with { type: 'json' };
import request from '../../fixtures/request.json' with { type: 'json' };
import researchers from '../../fixtures/researchers.json' with { type: 'json' };
import { registerDemoHandlers } from '../slack/handlers.js';
import { registerPilotHandlers, type PilotJob } from '../slack/pilot.js';

export interface ReceiverSettings {
  token: string; signingSecret: string; teamId: string; fictional: boolean;
  /** Hands the slow half of a pilot interaction to the worker. */
  dispatch: (job: PilotJob) => Promise<void>;
  /** Test hook for a local fake Slack API. */
  slackApiUrl?: string;
}

/**
 * Slack's HTTP entry point. Bolt verifies the request signature, and every handler finishes before the response is returned, so
 * handlers here only acknowledge, open or replace a loading view, and dispatch. `/resource-demo` runs entirely here: it is pure
 * scoring on bundled fictional data; its Gemini option falls back to the labelled factual template because hosted mode has no key.
 */
export function createReceiverHandler(settings: ReceiverSettings) {
  const receiver = new AwsLambdaReceiver({ signingSecret: settings.signingSecret });
  // No retries: a slow Slack call here would spend the 3-second acknowledgement budget. No startup auth.test: this app handles
  // only commands and modals (no events), so the bot identity is never needed and a cold start saves a round trip.
  const app = new App({ token: settings.token, receiver, tokenVerificationEnabled: false,
    clientOptions: { retryConfig: { retries: 0 }, ...(settings.slackApiUrl ? { slackApiUrl: settings.slackApiUrl } : {}) } });
  registerDemoHandlers(app, settings.teamId, { researchers, request, config }, async () => {});
  registerPilotHandlers(app, undefined, { fictional: settings.fictional }, settings.dispatch);
  return receiver.toHandler();
}
