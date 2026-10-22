import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/chord/sqlite';

/** Native surface used by the driver; also permits a real SQLite connection in Node tests. */
export interface ExpoSqliteConnection {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: ExpoSqliteParameter[]): Promise<unknown>;
  getFirstAsync<T extends object>(sql: string, params: ExpoSqliteParameter[]): Promise<T | null>;
  getAllAsync<T extends object>(sql: string, params: ExpoSqliteParameter[]): Promise<T[]>;
  closeAsync(): Promise<void>;
}

type ExpoSqliteParameter = Exclude<SqliteValue, bigint>;

function bindParameters(params: SqliteValue[]): ExpoSqliteParameter[] {
  return params.map((value) => {
    if (typeof value !== 'bigint') return value;
    // Expo binds JS numbers rather than int64 BigInts. Durable IDs already use
    // safe integers; reject larger values instead of silently rounding them.
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError('SQLite bigint binding exceeds the safe integer range');
    return number;
  });
}

class OperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    // Failure must release the queue without hiding the caller's rejection.
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  drain(): Promise<void> {
    return this.tail;
  }
}

function executor(database: ExpoSqliteConnection, schedule: <T>(operation: () => Promise<T>) => Promise<T>): SqliteExecutor {
  return {
    exec: (sql) => schedule(() => database.execAsync(sql)),
    run: (sql, ...params) => schedule(async () => { await database.runAsync(sql, bindParameters(params)); }),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) => schedule(async () =>
      (await database.getFirstAsync<T>(sql, bindParameters(params))) ?? undefined),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) => schedule(() =>
      database.getAllAsync<T>(sql, bindParameters(params))),
  };
}

/**
 * Owns one Expo connection. Use only the transaction handle inside its callback
 * and await its operations; database-level calls intentionally wait behind it.
 */
export function createExpoSqliteDatabase(database: ExpoSqliteConnection): SqliteDatabase {
  const access = new OperationQueue();
  let closed = false;
  let closing: Promise<void> | undefined;
  let failure: AggregateError | undefined;

  function assertOpen() {
    if (closed) throw new Error('SQLite database is closed');
    if (failure) throw failure;
  }

  function schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error('SQLite database is closing or closed'));
    return access.run(async () => {
      assertOpen();
      return operation();
    });
  }

  return {
    ...executor(database, schedule),
    transaction: <T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> => schedule(async () => {
      await database.execAsync('BEGIN IMMEDIATE');
      let active = true;
      const work = new OperationQueue();
      const transaction = executor(database, <R>(operation: () => Promise<R>) => {
        if (!active) return Promise.reject(new Error('SQLite transaction handle is no longer active'));
        return work.run(operation);
      });
      try {
        const result = await callback(transaction);
        active = false;
        // Drain already admitted native calls before ending the SQL transaction,
        // including when Promise.all rejected while another call was in flight.
        await work.drain();
        await database.execAsync('COMMIT');
        return result;
      } catch (error) {
        active = false;
        await work.drain();
        try {
          await database.execAsync('ROLLBACK');
        } catch (rollbackError) {
          failure = new AggregateError([error, rollbackError], 'SQLite transaction failed and rollback failed');
          throw failure;
        }
        throw error;
      }
    }),
    close: () => {
      if (!closing) {
        closing = access.run(async () => {
          closed = true;
          await database.closeAsync();
        });
      }
      return closing;
    },
  };
}
