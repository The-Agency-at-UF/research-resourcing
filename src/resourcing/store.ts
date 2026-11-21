export interface Row<T = unknown> { key: string; version: number; data: T }
export interface Check { key: string; version: number | null }
export interface ResourcingStore {
  get<T>(key: string): Promise<Row<T> | undefined>;
  getMany(keys: string[]): Promise<(Row | undefined)[]>;
  list<T>(prefix: string): Promise<Row<T>[]>;
  commit(puts: Row[], checks: Check[]): Promise<void>;
}
export class ConflictError extends Error { constructor() { super('Records changed; refresh and review again.'); } }
export class MemoryStore implements ResourcingStore {
  private rows = new Map<string, Row>();
  async get<T>(key: string) { return structuredClone(this.rows.get(key)) as Row<T> | undefined; }
  async getMany(keys: string[]) { return keys.map(key => structuredClone(this.rows.get(key))); }
  async list<T>(prefix: string) { return [...this.rows.values()].filter(r => r.key.startsWith(prefix)).map(r => structuredClone(r)) as Row<T>[]; }
  async commit(puts: Row[], checks: Check[]) {
    validateTransaction(puts, checks);
    for (const check of checks) if ((this.rows.get(check.key)?.version ?? null) !== check.version) throw new ConflictError();
    // No await between checking and writing: equivalent atomic semantics for unit tests.
    for (const row of puts) this.rows.set(row.key, structuredClone(row));
  }
}
export function validateTransaction(puts: Row[], checks: Check[]) {
  if (new Set(puts.map(p => p.key)).size !== puts.length || new Set(checks.map(c => c.key)).size !== checks.length) throw new Error('Duplicate transaction keys');
  if (puts.length + checks.filter(c => !puts.some(p => p.key === c.key)).length > 100) throw new Error('Transaction is too large');
  for (const row of puts) {
    const check = checks.find(c => c.key === row.key);
    if (!check || row.version !== (check.version ?? 0) + 1) throw new Error('Every write must increment a checked version');
    if (Buffer.byteLength(JSON.stringify(row)) > 350_000) throw new Error('Record is too large; archive through a versioned migration before continuing');
  }
}
