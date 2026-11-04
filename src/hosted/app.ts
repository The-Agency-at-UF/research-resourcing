import { App, AwsLambdaReceiver } from '@slack/bolt';
import { registerResourcingHandlers, type ResourcingJob } from '../slack/resourcing.js';

export interface ReceiverSettings {
  token: string; signingSecret: string; fictional: boolean;
  /** Hands the slow half of an interaction to the worker. */
  dispatch: (job: ResourcingJob) => Promise<void>;
  /** Test hook for a local fake Slack API. */
  slackApiUrl?: string;
}

/**
 * Slack's HTTP entry point. Bolt verifies the request signature, and every handler finishes before the response is returned, so
 * handlers here only acknowledge, open or replace a loading view, and dispatch; the worker checks the workspace and manager.
 */
export function createReceiverHandler(settings: ReceiverSettings) {
  const receiver = new AwsLambdaReceiver({ signingSecret: settings.signingSecret });
  // No retries: a slow Slack call here would spend the 3-second acknowledgement budget. No startup auth.test: this app handles
  // only commands and modals (no events), so the bot identity is never needed and a cold start saves a round trip.
  const app = new App({ token: settings.token, receiver, tokenVerificationEnabled: false,
    clientOptions: { retryConfig: { retries: 0 }, ...(settings.slackApiUrl ? { slackApiUrl: settings.slackApiUrl } : {}) } });
  registerResourcingHandlers(app, undefined, { fictional: settings.fictional }, settings.dispatch);
  return receiver.toHandler();
}
