import type { Bindings } from '../index';
import { hasPremium, requireAddressSlot } from '../lib/findings';
import { scanAddress } from '../lib/scan';
import { APIError, decrypt } from '../lib/security';

export type MonitoringMessage = { jobId: string };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const daily = 86400;

async function eligible(env: Bindings, userId: string, addressId: string) {
  if (!(await hasPremium(env, userId, ''))) return false;
  try {
    await requireAddressSlot(env, userId, addressId, '');
    return true;
  } catch (error) {
    if (error instanceof APIError && error.code === 'subscription_required') return false;
    throw error;
  }
}

export async function scheduleMonitoring(env: Bindings) {
  if (env.DATA_MODE !== 'live' || env.APP_ENV === 'production' || !env.MONITORING_QUEUE) return;
  const now = nowSeconds();
  const due =
    await env.DB.prepare(`SELECT id, user_id, monitoring_generation, next_check_at, last_monitoring_outcome FROM monitored_emails
    WHERE monitoring_enabled = 1 AND (next_check_at <= ? OR last_monitoring_outcome = 'paused_plan') ORDER BY next_check_at, id LIMIT 100`)
      .bind(now)
      .all<{
        id: string;
        user_id: string;
        monitoring_generation: number;
        next_check_at: number;
        last_monitoring_outcome: string | null;
      }>();
  for (const address of due.results) {
    if (!(await eligible(env, address.user_id, address.id))) {
      if (address.next_check_at > now) continue;
      await env.DB.prepare(
        'UPDATE monitored_emails SET next_check_at = ?, last_monitoring_outcome = ? WHERE id = ? AND monitoring_generation = ?',
      )
        .bind(now + daily, 'paused_plan', address.id, address.monitoring_generation)
        .run();
      continue;
    }
    if (address.last_monitoring_outcome === 'paused_plan') {
      // A plan pause is not a failed scan. Resume immediately when access
      // returns instead of retaining the pause's one-day deferral.
      const resumed = await env.DB.prepare(`UPDATE monitored_emails
        SET next_check_at = ?, last_monitoring_outcome = 'pending'
        WHERE id = ? AND monitoring_enabled = 1 AND monitoring_generation = ?
        AND last_monitoring_outcome = 'paused_plan' RETURNING id`)
        .bind(now, address.id, address.monitoring_generation)
        .first();
      if (!resumed) continue;
      address.next_check_at = now;
    }
    await env.DB.prepare(`INSERT INTO monitoring_jobs (id, address_id, generation, scheduled_at)
      SELECT ?, id, monitoring_generation, next_check_at FROM monitored_emails
      WHERE id = ? AND monitoring_enabled = 1 AND monitoring_generation = ?
      ON CONFLICT(address_id, generation, scheduled_at) DO NOTHING`)
      .bind(crypto.randomUUID(), address.id, address.monitoring_generation)
      .run();
  }
  // Re-send stalled dispatches after 15 minutes: send and database writes cannot
  // be one transaction. The consumer's durable job claim makes this safe.
  const jobs =
    await env.DB.prepare(`SELECT j.id FROM monitoring_jobs j JOIN monitored_emails a ON a.id = j.address_id
    WHERE j.status IN ('pending', 'running') AND j.dispatched_at <= ? AND j.lease_until <= ?
    AND a.monitoring_enabled = 1 AND a.monitoring_generation = j.generation ORDER BY j.scheduled_at LIMIT 100`)
      .bind(now - 900, now)
      .all<{ id: string }>();
  for (const job of jobs.results) {
    await env.MONITORING_QUEUE.send({ jobId: job.id });
    await env.DB.prepare('UPDATE monitoring_jobs SET dispatched_at = ? WHERE id = ?')
      .bind(now, job.id)
      .run();
  }
}

export async function processMonitoring(env: Bindings, jobId: string) {
  if (env.DATA_MODE !== 'live' || env.APP_ENV === 'production') return;
  const now = nowSeconds();
  const job =
    await env.DB.prepare(`UPDATE monitoring_jobs SET status = 'running', lease_until = ?, attempts = attempts + 1
    WHERE id = ? AND status IN ('pending', 'running') AND lease_until <= ? RETURNING *`)
      .bind(now + 90, jobId, now)
      .first<{ address_id: string; generation: number; attempts: number }>();
  if (!job) {
    const running = await env.DB.prepare(
      "SELECT id FROM monitoring_jobs WHERE id = ? AND status = 'running'",
    )
      .bind(jobId)
      .first();
    if (running) throw new APIError('rate_limited', 429, 'Monitoring job is already running.', 90);
    return;
  }
  const address =
    await env.DB.prepare(`SELECT id, user_id, encrypted_email, is_primary, known_breach_count, checked_at FROM monitored_emails
    WHERE id = ? AND monitoring_enabled = 1 AND monitoring_generation = ?`)
      .bind(job.address_id, job.generation)
      .first<{
        id: string;
        user_id: string;
        encrypted_email: string;
        is_primary: number;
        known_breach_count: number | null;
        checked_at: string | null;
      }>();
  if (!address || !(await eligible(env, address.user_id, address.id))) {
    await env.DB.prepare(
      "UPDATE monitoring_jobs SET status = 'paused', lease_until = 0, completed_at = ?, outcome = 'paused' WHERE id = ?",
    )
      .bind(now, jobId)
      .run();
    return;
  }
  try {
    await scanAddress(
      env,
      address.user_id,
      {
        id: address.id,
        email: await decrypt(env.DATA_ENCRYPTION_KEY as string, address.encrypted_email),
        verified: true,
        isPrimary: address.is_primary === 1,
        knownBreachCount: address.known_breach_count,
        checkedAt: address.checked_at,
      },
      job.generation,
    );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE monitoring_jobs SET status = 'complete', lease_until = 0, completed_at = ?, outcome = 'success' WHERE id = ?",
      ).bind(now, jobId),
      env.DB.prepare(`UPDATE monitored_emails SET next_check_at = ?, last_monitoring_at = ?, last_monitoring_outcome = 'success'
        WHERE id = ? AND monitoring_enabled = 1 AND monitoring_generation = ?`).bind(
        now + daily,
        new Date().toISOString(),
        address.id,
        job.generation,
      ),
    ]);
  } catch (error) {
    const code = error instanceof APIError ? error.code : 'internal_error';
    const paused =
      code === 'not_found' || code === 'unauthorised' || code === 'subscription_required';
    const exhausted = job.attempts >= 8;
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE monitoring_jobs SET status = ?, lease_until = 0, completed_at = ?, outcome = ? WHERE id = ?',
      ).bind(
        paused ? 'paused' : exhausted ? 'failed' : 'pending',
        paused || exhausted ? now : null,
        code,
        jobId,
      ),
      env.DB.prepare(`UPDATE monitored_emails SET last_monitoring_outcome = ?, next_check_at = CASE WHEN ? = 1 THEN ? ELSE next_check_at END
        WHERE id = ? AND monitoring_enabled = 1 AND monitoring_generation = ?`).bind(
        code,
        exhausted ? 1 : 0,
        now + daily,
        address.id,
        job.generation,
      ),
    ]);
    if (!paused && !exhausted) throw error;
  }
}

export async function consumeMonitoring(batch: MessageBatch<MonitoringMessage>, env: Bindings) {
  for (const message of batch.messages) {
    if (
      !message.body ||
      typeof message.body.jobId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(message.body.jobId)
    ) {
      message.ack();
      continue;
    }
    try {
      await processMonitoring(env, message.body.jobId);
      message.ack();
    } catch (error) {
      const backoff = Math.min(3600, 60 * 2 ** Math.min(message.attempts - 1, 6));
      message.retry({
        delaySeconds: Math.min(
          43200,
          Math.max(backoff, error instanceof APIError ? (error.retryAfter ?? 0) : 0),
        ),
      });
    }
  }
}
