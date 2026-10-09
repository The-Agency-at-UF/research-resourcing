import { GoogleGenAI, type GenerateContentParameters } from '@google/genai';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { RecommendationRun } from '../recommendations/models.js';
import { managerMessage } from '../recommendations/presentation.js';

const selectionSchema = z.object({
  candidates: z.array(z.object({
    researcherId: z.string().min(1),
    factIndexes: z.array(z.number().int().nonnegative()).min(2).max(4),
  }).strict()).max(3),
}).strict();

export const GEMINI_BASE_MODEL = 'gemini-flash-latest';
export const GEMINI_TIMEOUT_MS = 30000;
export const GEMINI_MAX_RETRIES = 10; // Ten retries after the initial request: at most eleven provider calls.
export type GenerateSelection = (params: GenerateContentParameters) => Promise<{ text?: string; modelVersion?: string }>;
export interface ExplanationResult {
  source: 'gemini' | 'template';
  reason: 'validated' | 'not_configured' | 'no_candidates' | 'model_unavailable' | 'invalid_output';
  message: string;
  attempts?: number;
  modelVersion?: string;
  selections?: z.infer<typeof selectionSchema>;
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? Number(error.status) : undefined;
  return status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)
    || ('name' in error && ['AbortError', 'TimeoutError'].includes(String(error.name)));
}

/** Reject changed identities/order, extra fields, invented facts, duplicate facts, or missing capacity/requirements. */
export function validateSelections(raw: unknown, run: RecommendationRun) {
  const selection = selectionSchema.parse(raw);
  if (selection.candidates.length !== run.displayed.length) throw new Error('Candidate count changed');
  selection.candidates.forEach((item, index) => {
    const candidate = run.displayed[index]!;
    if (item.researcherId !== candidate.researcherId) throw new Error('Candidate identity or ordering changed');
    if (new Set(item.factIndexes).size !== item.factIndexes.length) throw new Error('Duplicate fact');
    if (!item.factIndexes.includes(0) || !item.factIndexes.includes(2)) throw new Error('Availability or essential requirements omitted');
    if (item.factIndexes.some(i => i >= candidate.facts.length)) throw new Error('Unknown fact');
  });
  return selection;
}

export async function explainWithGemini(run: RecommendationRun, options: {
  apiKey?: string;
  model?: string;
  systemInstruction: string;
  generate?: GenerateSelection;
  waitForRetry?: (milliseconds: number) => Promise<void>;
}): Promise<ExplanationResult> {
  let attempts = 0;
  const fallback = (reason: ExplanationResult['reason']): ExplanationResult => ({source: 'template', reason, message: managerMessage(run), attempts});
  if (!run.displayed.length) return fallback('no_candidates');
  if (!options.apiKey && !options.generate) return fallback('not_configured');
  const model = options.model || GEMINI_BASE_MODEL;
  const contents = JSON.stringify({
    dataMode: 'fictional_demo',
    scoringPolicy: run.config,
    request: {hoursPerResearcher: run.request.hoursPerResearcher, openings: run.request.openings},
    displayed: run.displayed.map(r => ({researcherId: r.researcherId, rank: r.rank, score: r.score, facts: r.facts})),
  });
  const params: GenerateContentParameters = {
    model,
    contents,
    config: {
      systemInstruction: options.systemInstruction,
      temperature: 0.2,
      maxOutputTokens: 800,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object', additionalProperties: false, required: ['candidates'],
        properties: {candidates: {
          type: 'array', minItems: run.displayed.length, maxItems: run.displayed.length,
          items: {type: 'object', additionalProperties: false, required: ['researcherId', 'factIndexes'], properties: {
            researcherId: {type: 'string', enum: run.displayed.map(r => r.researcherId)},
            factIndexes: {type: 'array', minItems: 2, maxItems: 4, items: {type: 'integer', minimum: 0}},
          }},
        }},
      },
      httpOptions: {timeout: GEMINI_TIMEOUT_MS, retryOptions: {attempts: 1}},
    },
  };
  let response: {text?: string; modelVersion?: string} | undefined;
  const client = options.generate ? undefined : new GoogleGenAI({apiKey: options.apiKey});
  const generate = options.generate ?? ((input: GenerateContentParameters) => client!.models.generateContent(input));
  const waitForRetry = options.waitForRetry ?? (milliseconds => delay(milliseconds));
  for (let retry = 0; retry <= GEMINI_MAX_RETRIES; retry++) {
    attempts++;
    try {
      // The same model/payload on every call, with a fresh deadline. Disable SDK retries to avoid multiplying calls.
      response = await generate({...params, config: {...params.config, abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)}});
      break;
    } catch (error) {
      // Do not print provider errors or request details; authentication/configuration failures are not retried.
      if (retry === GEMINI_MAX_RETRIES || !isRetryable(error)) return fallback('model_unavailable');
      await waitForRetry(Math.min(1000 * 2 ** retry, 2000));
    }
  }
  try {
    const selections = validateSelections(JSON.parse(response?.text ?? ''), run);
    // Model output never becomes displayed prose. Only code-generated, verified facts are rendered.
    const displayed = run.displayed.map((r, index) => ({...r,
      explanation: selections.candidates[index]!.factIndexes.map(i => r.facts[i]!).join('; ') + '.',
    }));
    return {source: 'gemini', reason: 'validated', selections, attempts,
      ...(response?.modelVersion ? {modelVersion: response.modelVersion} : {}),
      message: managerMessage({...run, displayed})};
  } catch { return fallback('invalid_output'); }
}
