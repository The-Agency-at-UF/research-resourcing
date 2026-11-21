import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

/** Read SecureString parameters under the configured prefix once per cold start; secrets never sit in environment variables. */
export async function loadParameters<const N extends string>(names: readonly N[], prefix = process.env.PARAMETER_PREFIX ?? '', client = new SSMClient({})) {
  if (!prefix.startsWith('/')) throw new Error('Set PARAMETER_PREFIX to the SSM parameter path, e.g. /research-resourcing');
  const response = await client.send(new GetParametersCommand({ Names: names.map(n => `${prefix}/${n}`), WithDecryption: true }));
  const values = Object.fromEntries((response.Parameters ?? []).map(p => [p.Name!.slice(prefix.length + 1), p.Value ?? '']));
  const missing = names.filter(n => !values[n]);
  if (missing.length) throw new Error(`Missing SSM parameters: ${missing.map(n => `${prefix}/${n}`).join(', ')}`);
  return values as Record<N, string>;
}
