import { z } from 'zod';
import { requestSchema, researcherSchema, type RecommendationRun } from '../recommendations/models.js';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '0001-01-01';
}, 'Enter a real calendar date in YYYY-MM-DD format');
export const datedRequestSchema = requestSchema.extend({ startDate: dateSchema, endDate: dateSchema })
  .refine(r => r.startDate <= r.endDate, { path: ['endDate'], message: 'End date must not precede start date' });
export const assignmentSchema = z.object({
  id: z.string().min(1), accountId: z.string().min(1), startDate: dateSchema, endDate: dateSchema,
  hoursPerWeek: z.number().finite().positive(), status: z.enum(['active', 'cancelled']),
}).strict().refine(a => a.startDate <= a.endDate, 'Invalid assignment date range');
// Snapshot totals are intentionally absent: the schedule is the only commitment source.
const { committedHours: _committed, currentAccountIds: _accounts, ...profileShape } = researcherSchema.shape;
export const datedResearcherSchema = z.object({ ...profileShape,
  availableFrom: dateSchema, availableUntil: dateSchema, assignments: z.array(assignmentSchema),
  // Present when a 1:1 profile was imported; shown to managers, never used as capacity by itself.
  profile: z.object({ hoursPerWeek: z.number().finite().nonnegative().optional(), accountCap: z.number().int().positive().optional() }).strict().optional(),
}).strict().refine(r => r.availableFrom <= r.availableUntil, 'Invalid availability window')
  .refine(r => new Set(r.assignments.map(a => a.id)).size === r.assignments.length, 'Duplicate assignment IDs');
export type DatedRequest = z.infer<typeof datedRequestSchema>;
export type DatedResearcher = z.infer<typeof datedResearcherSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type DatedRun = Omit<RecommendationRun, 'request'> & { request: DatedRequest };
export interface Actor { teamId: string; userId: string }
export interface Manager { enabled: boolean; name: string }
export interface Account { id: string; name: string; industries?: string[] }
export interface RequestState {
  request: DatedRequest; filledResearcherIds: string[];
  status: 'awaiting_manager' | 'partial' | 'filled' | 'declined'; runId?: string; createdAt?: string;
}
export interface RunState { run: DatedRun; researcherVersions: Record<string, number>; configVersion: number }
export interface Review {
  requestId: string; runId: string; actor: Actor; selectedIds: string[]; requestVersion: number;
  managerVersion: number; configVersion: number; researcherVersions: Record<string, number>;
  summaries: { researcherId: string; name: string; hoursAfterAssignment: number }[]; createdAt: string;
}
export interface Approval { id: string; requestId: string; actor: Actor; assignmentIds: string[]; researcherIds: string[]; approvedAt: string }
export interface SeedInfo { fictional: boolean; schemaVersion: number; source?: string; capacity?: 'hours' | 'account-slots'; maxAccounts?: number }
export interface ImportReport { source: string; importedAt: string; warnings: string[]; excluded: { researcherId: string; reasons: string[] }[]; tools?: string[] }
type Span = Pick<Assignment, 'startDate' | 'endDate' | 'status'>;
export interface Change {
  id: string; action: 'cancel' | 'reschedule'; actor: Actor; researcherId: string; assignmentId: string; accountId: string;
  requestId?: string; before: Span; after: Span; changedAt: string;
}
export interface HqLocation { channel: string; ts: string }
export class PilotError extends Error {
  constructor(public code: 'unauthorized' | 'invalid' | 'stale' | 'closed' | 'not_found', message: string) { super(message); }
}
