import type { types, ViewOutput } from '@slack/bolt';
import { requestSchema, type RecommendationRun, type StaffingRequest } from '../recommendations/models.js';
import { managerMessage } from '../recommendations/presentation.js';

export const REQUEST_CALLBACK = 'resource_demo_request';
type Values = ViewOutput['state']['values'];
type FormResult = { ok: true; request: StaffingRequest } | { ok: false; errors: Record<string, string> };

const fields = [
  { id: 'accountId', label: 'Account ID', initial: 'sample-health', max: 80, hint: 'Use a fictional ID. Try sample-retail to test existing-account exclusions.' },
  { id: 'accountName', label: 'Project / account name', initial: 'Fictional Health Account', max: 80 },
  { id: 'hoursPerResearcher', label: 'Weekly hours per researcher', initial: '4', max: 20 },
  { id: 'openings', label: 'Number of openings', initial: '2', max: 3 },
  { id: 'requiredSkills', label: 'Required skills', initial: 'survey-design', max: 500, optional: true, hint: 'Comma-separated exact tags, such as survey-design, data-analysis, interviewing.' },
  { id: 'preferredSkills', label: 'Preferred skills', initial: 'data-analysis, interviewing', max: 500, optional: true },
  { id: 'minimumExperienceYears', label: 'Minimum years of experience', initial: '0', max: 20 },
  { id: 'careerInterests', label: 'Career interests', initial: 'consumer-research', max: 500, optional: true, hint: 'Comma-separated tags. Fictional examples: consumer-research, strategy.' },
  { id: 'industryId', label: 'Industry', initial: 'healthcare', max: 80, optional: true },
] as const;

export function requestModal(): types.ModalView {
  return {
    type: 'modal', callback_id: REQUEST_CALLBACK,
    title: { type: 'plain_text', text: 'Staffing request demo' },
    submit: { type: 'plain_text', text: 'Find candidates' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: 'Use fictional project details. This demo ranks sample researchers and makes no assignments.' } },
      ...fields.map(field => ({
        type: 'input' as const, block_id: field.id,
        label: { type: 'plain_text' as const, text: field.label },
        optional: 'optional' in field && field.optional,
        ...('hint' in field ? { hint: { type: 'plain_text' as const, text: field.hint } } : {}),
        element: { type: 'plain_text_input' as const, action_id: 'value', initial_value: field.initial, max_length: field.max },
      })),
    ],
  };
}

/** Validate the Slack boundary before passing a request to the shared scorer. */
export function parseRequestForm(values: Values): FormResult {
  const errors: Record<string, string> = {};
  const input = Object.fromEntries(fields.map(field => {
    const value = values[field.id]?.value?.value;
    if (value !== undefined && value !== null && typeof value !== 'string') errors[field.id] = 'Enter a text value.';
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > field.max) errors[field.id] = `Use at most ${field.max} characters.`;
    return [field.id, text];
  })) as Record<(typeof fields)[number]['id'], string>;
  const number = (field: 'hoursPerResearcher' | 'openings' | 'minimumExperienceYears') =>
    /^\d+(?:\.\d+)?$/.test(input[field]) ? Number(input[field]) : NaN;
  const tags = (field: 'requiredSkills' | 'preferredSkills' | 'careerInterests') =>
    input[field].split(',').map(tag => tag.trim()).filter(Boolean);
  const parsed = requestSchema.safeParse({
    accountId: input.accountId, accountName: input.accountName,
    hoursPerResearcher: number('hoursPerResearcher'), openings: number('openings'),
    requiredSkills: tags('requiredSkills'), preferredSkills: tags('preferredSkills'),
    minimumExperienceYears: number('minimumExperienceYears'), careerInterests: tags('careerInterests'),
    ...(input.industryId ? { industryId: input.industryId } : {}),
  });
  if (!parsed.success) {
    const messages: Record<string, string> = {
      accountId: 'Enter a fictional account ID.', accountName: 'Enter a project or account name.',
      hoursPerResearcher: 'Enter weekly hours greater than zero, such as 4 or 4.5.',
      openings: 'Enter a whole number from 1 to 100.', minimumExperienceYears: 'Enter zero or a positive number of years.',
    };
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0]);
      errors[field] ??= messages[field] ?? 'Review this field.';
    }
  }
  if (Object.keys(errors).length || !parsed.success) return { ok: false, errors };
  return { ok: true, request: parsed.data };
}

export function resultModal(run: RecommendationRun): types.ModalView {
  return {
    type: 'modal', title: { type: 'plain_text', text: 'Demo recommendations' },
    close: { type: 'plain_text', text: 'Done' },
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: 'FICTIONAL DATA DEMO — sample researchers only. No assignments have been saved.' } },
      ...managerMessage(run).split('\n\n').map(text => ({
        type: 'section' as const, text: { type: 'plain_text' as const, text },
      })),
    ],
  };
}
