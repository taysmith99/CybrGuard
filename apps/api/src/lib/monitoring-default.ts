import type { Bindings } from '../index';

// Run in the same transaction as confirmed billing or address creation.
// Only real, current paid snapshots can enable defaults; account deletion,
// quota changes and explicit opt-outs remain authoritative.
export function defaultMonitoring(env: Bindings, userId: string, now: number) {
  return env.DB.prepare(`UPDATE monitored_emails SET monitoring_enabled = 1,
    monitoring_preference_set = 1, monitoring_generation = monitoring_generation + 1,
    next_check_at = ?, last_monitoring_outcome = 'pending'
    WHERE user_id = ? AND (monitoring_preference_set = 0
      OR (monitoring_enabled = 1 AND last_monitoring_outcome = 'paused_plan'))
    AND ? = 1
    AND EXISTS (SELECT 1 FROM premium_entitlements WHERE user_id = ? AND expires_at > ?)
    AND id IN (SELECT id FROM monitored_emails WHERE user_id = ?
      ORDER BY is_primary DESC, verified_at, id
      LIMIT (SELECT max_addresses FROM premium_entitlements WHERE user_id = ?))`).bind(
    now,
    userId,
    env.MONITORING_QUEUE ? 1 : 0,
    userId,
    now,
    userId,
    userId,
  );
}
