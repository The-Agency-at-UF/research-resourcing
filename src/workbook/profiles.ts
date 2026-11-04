import { z } from 'zod';
import { dateSchema } from '../pilot/models.js';
import { slug } from './parse.js';

const tags = z.array(z.string().trim().min(1)).default([]).transform(values => [...new Set(values.map(slug).filter(Boolean))]);

/**
 * Staffing facts taken from researcher 1:1s, kept in ignored data/private because the source notes are personal.
 * Only these fields reach the pilot; the notes themselves are never imported.
 */
export const profilesSchema = z.object({
  source: z.string().trim().min(1),
  // Account name (as on the grid) → industry tags compared with researcher interests and industry experience.
  accounts: z.record(z.string().trim().min(1), tags).default({}),
  researchers: z.array(z.object({
    name: z.string().trim().min(1),
    hoursPerWeek: z.number().finite().nonnegative().optional(),
    // The most accounts the researcher asked to hold; lower than the department cap when they said they are at capacity.
    accountCap: z.number().int().positive().optional(),
    // Last day they can work, when a 1:1 says they leave or study away before graduating.
    availableUntil: dateSchema.optional(),
    interests: tags, industryExperience: tags, tools: tags,
  }).strict()),
}).strict();
export type Profiles = z.infer<typeof profilesSchema>;
export type Profile = Profiles['researchers'][number];

export const accountIndustries = (profiles: Profiles | undefined) =>
  new Map(Object.entries(profiles?.accounts ?? {}).map(([name, industries]) => [slug(name), industries]));
