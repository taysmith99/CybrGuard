import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';

// Real SQLite execution, including transactions and conditional RETURNING statements.
// This is an offline test adapter for D1's SQL interface, not a production database.
export function testDatabase() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_development_bootstrap.sql',
    '0002_verified_scan.sql',
    '0003_premium_findings.sql',
    '0004_details_timestamp.sql',
    '0005_remediation_steps.sql',
    '0006_multiple_addresses.sql',
    '0007_monitoring.sql',
    '0008_billing.sql',
  ]) {
    db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const prepare = (sql: string, args: (string | number | null)[] = []) => ({
    bind: (...values: (string | number | null)[]) => prepare(sql, values),
    first: async (column?: string) => {
      const row = db.prepare(sql).get(...args);
      return row ? (column ? row[column] : row) : null;
    },
    all: async () => ({ success: true, results: db.prepare(sql).all(...args) }),
    execute: () => {
      const result = db.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
    run: async () => prepare(sql, args).execute(),
  });
  return {
    raw: db,
    binding: {
      prepare,
      batch: async (statements: { execute: () => unknown }[]) => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(statement.execute());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as D1Database,
  };
}
