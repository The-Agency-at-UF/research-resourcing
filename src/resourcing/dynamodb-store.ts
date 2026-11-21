import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactGetCommand, TransactWriteCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { ConflictError, validateTransaction, type Check, type ResourcingStore, type Row } from './store.js';

export class DynamoStore implements ResourcingStore {
  private pk: string;
  constructor(private client: DynamoDBDocumentClient, private tableName: string, namespace: string) {
    if (!tableName || !/^[a-zA-Z0-9_-]{1,80}$/.test(namespace)) throw new Error('Configure a workflow table and valid namespace');
    this.pk = `RESOURCING#${namespace}`;
  }
  private key(key: string) { return { pk: this.pk, sk: key }; }
  async get<T>(key: string) { return (await this.getMany([key]))[0] as Row<T> | undefined; }
  async getMany(keys: string[]): Promise<(Row | undefined)[]> {
    if (!keys.length) return [];
    if (keys.length > 100 || new Set(keys).size !== keys.length) throw new Error('Invalid transactional read keys');
    const response = await this.client.send(new TransactGetCommand({ TransactItems: keys.map(key => ({ Get: { TableName: this.tableName, Key: this.key(key) } })) }));
    return keys.map((key, i) => { const item = response.Responses?.[i]?.Item; return item ? { key, version: item.version, data: item.data } : undefined; });
  }
  async list<T>(prefix: string): Promise<Row<T>[]> {
    const rows: Row<T>[] = []; let cursor;
    do {
      const response: QueryCommandOutput = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true,
        KeyConditionExpression: prefix ? 'pk = :pk AND begins_with(sk, :prefix)' : 'pk = :pk',
        ExpressionAttributeValues: { ':pk': this.pk, ...(prefix ? { ':prefix': prefix } : {}) },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      for (const item of response.Items ?? []) rows.push({ key: item.sk, version: item.version, data: item.data });
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return rows;
  }
  async commit(puts: Row[], checks: Check[]) {
    validateTransaction(puts, checks);
    const condition = (c: Check) => c.version === null
      ? { ConditionExpression: 'attribute_not_exists(pk)' }
      : { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': c.version } };
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        ...puts.map(row => ({ Put: { TableName: this.tableName, Item: { ...this.key(row.key), version: row.version, data: row.data }, ...condition(checks.find(c => c.key === row.key)!) } })),
        ...checks.filter(c => !puts.some(p => p.key === c.key)).map(c => ({ ConditionCheck: { TableName: this.tableName, Key: this.key(c.key), ...condition(c) } })),
      ] }));
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException' && 'CancellationReasons' in error &&
          Array.isArray(error.CancellationReasons) && error.CancellationReasons.some(r => r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict')) throw new ConflictError();
      throw error;
    }
  }
}
export function configuredStore() {
  const table = process.env.WORKFLOW_TABLE, namespace = process.env.RESOURCING_NAMESPACE ?? 'fictional-v1';
  if (!table || !process.env.AWS_REGION) throw new Error('Set WORKFLOW_TABLE and AWS_REGION');
  return new DynamoStore(DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  }), table, namespace);
}
