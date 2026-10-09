import type { App } from '@slack/bolt';
import { recommend } from '../recommendations/scoring.js';
import type { RecommendationRun } from '../recommendations/models.js';
import type { ExplanationResult } from '../integrations/gemini.js';
import { managerMessage } from '../recommendations/presentation.js';
import { REQUEST_CALLBACK, parseRequestForm, requestModal, resultModal } from './request-form.js';

interface DemoData { researchers: unknown[]; request: unknown; config: unknown }

export function registerDemoHandlers(
  app: Pick<App, 'command' | 'view'>,
  teamId: string,
  data: DemoData,
  recordRun: (run: RecommendationRun, explanation?: ExplanationResult) => Promise<void>,
  explain?: (run: RecommendationRun) => Promise<ExplanationResult>,
): void {
  app.command('/resource-demo', async ({ command, ack, respond, client }) => {
    await ack();
    if (command.team_id !== teamId) return;
    const action = command.text.trim().toLowerCase();
    if (action && action !== 'form' && action !== 'ai') {
      await respond({ response_type: 'ephemeral', text: 'Use /resource-demo for the sample result, /resource-demo form for a fictional staffing request, or /resource-demo ai to test Gemini with the sample data.' });
      return;
    }
    try {
      if (action === 'form') {
        await client.views.open({ trigger_id: command.trigger_id, view: requestModal() });
        return;
      }
      const run = recommend(data.researchers, data.request, data.config);
      if (action === 'ai') await respond({ response_type: 'ephemeral', text: 'FICTIONAL DATA DEMO\nContacting Gemini. Transient failures receive up to 10 retries against the same model; this can take several minutes. No other model will be used.' });
      const explanation = action === 'ai'
        ? await (explain?.(run) ?? Promise.resolve({ source: 'template' as const, reason: 'not_configured' as const, message: managerMessage(run), attempts: 0 }))
        : undefined;
      const source = explanation
        ? (explanation.source === 'gemini' ? 'Gemini connected: verified fact selection.' : `Template fallback (${explanation.reason}); Gemini output was not used.`)
        : 'Deterministic scoring and factual templates.';
      const attempts = explanation?.attempts !== undefined ? ` Provider requests: ${explanation.attempts}.` : '';
      await respond({ response_type: 'ephemeral', ...(action === 'ai' ? { replace_original: true } : {}), text: `FICTIONAL DATA DEMO\n${source}${attempts}\n\n${explanation?.message ?? managerMessage(run)}` });
      await recordRun(run, explanation);
    } catch {
      await respond({ response_type: 'ephemeral', text: 'The demo could not complete. Check the local process and Slack interactivity settings, then try again.' });
    }
  });

  app.view(REQUEST_CALLBACK, async ({ body, view, ack }) => {
    if (body.team?.id !== teamId) { await ack(); return; }
    const parsed = parseRequestForm(view.state.values);
    if (!parsed.ok) {
      await ack({ response_action: 'errors', errors: parsed.errors });
      return;
    }
    let run: RecommendationRun;
    try { run = recommend(data.researchers, parsed.request, data.config); }
    catch {
      await ack({ response_action: 'errors', errors: { accountName: 'The demo data or scoring configuration could not be loaded. Ask the developer to check the local process.' } });
      return;
    }
    // All data is loaded at startup, so scoring and validation need no network or disk I/O before acknowledgement.
    await ack({ response_action: 'update', view: resultModal(run) });
    await recordRun(run);
  });
}
