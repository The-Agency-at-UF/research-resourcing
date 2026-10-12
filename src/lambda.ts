import { z } from 'zod';
import { recommend } from './recommendations/scoring.js';

const payloadSchema = z.object({ researchers: z.array(z.unknown()), request: z.unknown(), config: z.unknown() }).strict();

/** Direct-invoke development handler. An authenticated Slack HTTP receiver comes later. */
export async function handler(event: unknown) {
  try {
    const payload = payloadSchema.parse(event);
    return { statusCode: 200, body: JSON.stringify(recommend(payload.researchers, payload.request, payload.config)) };
  } catch (error) {
    if (error instanceof z.ZodError) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid recommendation input', issues: error.issues }) };
    throw error;
  }
}
