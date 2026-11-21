import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoStore } from '../src/resourcing/dynamodb-store.js';
import { ConflictError } from '../src/resourcing/store.js';

test('Dynamo namespace listing omits an empty sort-key value and follows consistent query pages', async () => {
  const calls: any[] = [];
  const client = { send: async (command: any) => {
    calls.push(command.input);
    return calls.length === 1 ? { Items: [{ sk: 'CONFIG', version: 1, data: {} }], LastEvaluatedKey: { pk: 'RESOURCING#test', sk: 'CONFIG' } } : { Items: [{ sk: 'SEED', version: 1, data: {} }] };
  } } as unknown as DynamoDBDocumentClient;
  const store = new DynamoStore(client, 'table', 'test');
  assert.equal((await store.list('')).length, 2);
  assert.equal(calls[0].KeyConditionExpression, 'pk = :pk'); assert.deepEqual(calls[0].ExpressionAttributeValues, { ':pk': 'RESOURCING#test' });
  assert.equal(calls[1].ConsistentRead, true); assert.deepEqual(calls[1].ExclusiveStartKey, { pk: 'RESOURCING#test', sk: 'CONFIG' });
});
test('Dynamo writes put the version condition on the write itself and check read-only records separately', async () => {
  let input: any;
  const store = new DynamoStore({ send: async (command: any) => { input = command.input; return {}; } } as unknown as DynamoDBDocumentClient, 'table', 'test');
  await store.commit([{ key: 'RESEARCHER#a', version: 2, data: {} }], [{ key: 'RESEARCHER#a', version: 1 }, { key: 'CONFIG', version: 3 }]);
  assert.equal(input.TransactItems.length, 2); assert.equal(input.TransactItems[0].Put.ConditionExpression, '#v = :v');
  assert.equal(input.TransactItems[1].ConditionCheck.Key.sk, 'CONFIG');
});
test('Dynamo conditional failures become explicit stale-record conflicts', async () => {
  const store = new DynamoStore({ send: async () => { throw Object.assign(new Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }); } } as unknown as DynamoDBDocumentClient, 'table', 'test');
  await assert.rejects(store.commit([{ key: 'REQUEST#a', version: 1, data: {} }], [{ key: 'REQUEST#a', version: null }]), ConflictError);
});
