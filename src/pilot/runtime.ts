import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Refuse to use ambient credentials in another project's AWS account. */
export async function verifyPilotTarget() {
  if (process.env.AWS_REGION !== 'us-east-2' || process.env.PILOT_AWS_ACCOUNT_ID !== '726964604716' ||
      !['research-resourcing-dev', 'research-resourcing-pilot'].includes(process.env.AWS_PROFILE ?? '')) throw new Error('Configure the dedicated Research pilot profile, account 726964604716, and us-east-2.');
  const { stdout } = await promisify(execFile)('aws', ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'], { timeout: 20_000 });
  if (JSON.parse(stdout).Account !== process.env.PILOT_AWS_ACCOUNT_ID) throw new Error('AWS identity is not the Research Resourcing account.');
}
