import { z } from 'zod';

const id = z.string().trim().min(1);
const nonnegative = z.number().finite().nonnegative();
const tags = z.array(id).transform(values => [...new Set(values.map(v => v.toLowerCase()))]);

export const researcherSchema = z.object({
  id,
  name: id,
  active: z.boolean(),
  weeklyCapacityHours: z.number().finite().positive(),
  committedHours: nonnegative,
  maxAccounts: z.number().int().positive(),
  currentAccountIds: z.array(id).refine(values => new Set(values).size === values.length, 'Duplicate current account IDs'),
  skills: tags,
  experienceYears: nonnegative,
  interests: tags,
  industryExperienceIds: tags,
}).strict().refine(r => r.committedHours <= r.weeklyCapacityHours, {
  message: 'Committed hours exceed weekly capacity', path: ['committedHours'],
}).refine(r => r.currentAccountIds.length <= r.maxAccounts, {
  message: 'Current account load exceeds maximum', path: ['currentAccountIds'],
});

export const requestSchema = z.object({
  accountId: id,
  accountName: id,
  hoursPerResearcher: z.number().finite().positive(),
  openings: z.number().int().min(1).max(100),
  requiredSkills: tags,
  preferredSkills: tags,
  minimumExperienceYears: nonnegative,
  careerInterests: tags,
  industryId: id.transform(v => v.toLowerCase()).optional(),
}).strict();

export const criteria = ['bandwidth', 'skills', 'experience', 'interests', 'accountLoad', 'industry'] as const;
export type Criterion = typeof criteria[number];
const weight = z.number().finite().nonnegative().max(1);
export const configSchema = z.object({
  version: id,
  weights: z.object({ bandwidth: weight, skills: weight, experience: weight, interests: weight, accountLoad: weight, industry: weight }).strict(),
  experienceReferenceYears: z.number().finite().positive(),
  retainCount: z.literal(5),
  displayCount: z.union([z.literal(2), z.literal(3)]),
}).strict().refine(c => Math.abs(Object.values(c.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9, {
  message: 'Weights must sum to 1', path: ['weights'],
}).refine(c => criteria.filter(k => k !== 'bandwidth').every(k => c.weights.bandwidth > c.weights[k]), {
  message: 'Bandwidth must have a strictly higher weight than every other criterion', path: ['weights', 'bandwidth'],
});

export type Researcher = z.infer<typeof researcherSchema>;
export type StaffingRequest = z.infer<typeof requestSchema>;
export type ScoringConfig = z.infer<typeof configSchema>;
export type Breakdown = Record<Criterion, { value: number | null; effectiveWeight: number; contribution: number }>;
export interface Recommendation {
  researcherId: string;
  name: string;
  rank: number;
  score: number;
  remainingHours: number;
  hoursAfterAssignment: number;
  matchedSkills: string[];
  matchedInterests: string[];
  explanation: string;
  facts: string[];
  breakdown: Breakdown;
}
export interface RecommendationRun {
  request: StaffingRequest;
  config: ScoringConfig;
  status: 'ready' | 'partial' | 'no_eligible';
  eligibleCount: number;
  retained: Recommendation[];
  displayed: Recommendation[];
  excluded: { researcherId: string; reasons: string[]; dataIssue: boolean }[];
  warnings: string[];
}
