import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOURS, type CapacityUnits } from './units.js';
import type { SeedInfo } from './models.js';
import type { PilotStore } from './store.js';

/**
 * Refuse to use ambient credentials in another project's AWS account. Locally a dedicated profile is required and STS confirms
 * the account; the hosted Lambdas pass the account from their own function ARN instead (there is no AWS CLI in Lambda).
 */
export async function verifyPilotTarget(hostedAccountId?: string) {
  if (process.env.AWS_REGION !== 'us-east-2' || process.env.PILOT_AWS_ACCOUNT_ID !== '726964604716') throw new Error('Configure the Research pilot account 726964604716 and us-east-2.');
  if (hostedAccountId !== undefined) {
    if (hostedAccountId !== process.env.PILOT_AWS_ACCOUNT_ID) throw new Error('This function is not running in the Research Resourcing account.');
    return;
  }
  if (!['research-resourcing-dev', 'research-resourcing-pilot'].includes(process.env.AWS_PROFILE ?? '')) throw new Error('Configure the dedicated Research pilot profile.');
  const { stdout } = await promisify(execFile)('aws', ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'], { timeout: 20_000 });
  if (JSON.parse(stdout).Account !== process.env.PILOT_AWS_ACCOUNT_ID) throw new Error('AWS identity is not the Research Resourcing account.');
}

/** Capacity units and data label recorded when the namespace was seeded. */
export async function seedSettings(store: PilotStore): Promise<{ units: CapacityUnits; fictional: boolean }> {
  const seed = (await store.get<SeedInfo>('SEED'))?.data;
  return { units: seed?.capacity === 'account-slots' ? { kind: 'account-slots', maxAccounts: seed.maxAccounts ?? 3 } : HOURS, fictional: seed?.fictional !== false };
}
export const idList = (value: string | undefined) => (value ?? '').split(',').map(v => v.trim()).filter(v => /^[CDGUW][A-Z0-9]+$/.test(v));
