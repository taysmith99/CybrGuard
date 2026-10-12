import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { expect, it } from 'vitest';

it('preserves verified identity, findings and action progress when enabling multiple addresses', () => {
  const db = new DatabaseSync(':memory:');
  const migrate = (name: string) =>
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  for (const name of [
    '0001_development_bootstrap.sql',
    '0002_verified_scan.sql',
    '0003_premium_findings.sql',
    '0004_details_timestamp.sql',
    '0005_remediation_steps.sql',
  ])
    migrate(name);
  db.exec(`INSERT INTO users VALUES ('user', 1);
    INSERT INTO monitored_emails (id, user_id, encrypted_email, email_index, verified_at, consent_at, known_breach_count)
      VALUES ('address', 'user', 'ciphertext', 'blind-index', 1, 1, 2);
    INSERT INTO findings VALUES ('finding', 'address', 'breach', 'encrypted-details', 'first', 'last', 1, 'remediated');
    INSERT INTO finding_actions VALUES ('finding', 'change-password', 'completed');
    INSERT INTO premium_entitlements VALUES ('user', 9999999999);`);
  db.exec('BEGIN');
  migrate('0006_multiple_addresses.sql');
  db.exec('COMMIT');
  expect(
    db.prepare('SELECT is_primary, known_breach_count FROM monitored_emails').get(),
  ).toMatchObject({ is_primary: 1, known_breach_count: 2 });
  expect(db.prepare('SELECT remediated_at, encrypted_details FROM findings').get()).toMatchObject({
    remediated_at: 'remediated',
    encrypted_details: 'encrypted-details',
  });
  expect(db.prepare('SELECT completed_at FROM finding_actions').get()).toMatchObject({
    completed_at: 'completed',
  });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  db.exec("DELETE FROM users WHERE id = 'user'");
  for (const table of ['monitored_emails', 'findings', 'finding_actions', 'premium_entitlements'])
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
  db.close();
});
