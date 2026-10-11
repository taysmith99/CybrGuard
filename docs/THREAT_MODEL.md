# Threat model

This is a development threat model, not a security certification. The local vertical slice implements verification, device-bound sessions, encrypted addresses, real manual counts and account deletion. Premium billing, background jobs, APNs and deployable perimeter controls remain future work.

| Threat | Required control before feature release | Verification |
| --- | --- | --- |
| Third-party email enumeration or scanning | Generic auth responses; independent email ownership proof; rate limits and consent | Unverified and cross-account requests cannot obtain counts or details |
| Verification or session replay | Hashed short-lived one-time codes; bounded attempts; token rotation and revocation | Expired, reused and revoked credentials fail |
| Broken resource ownership | Server-derived identity on every resource; unpredictable identifiers | Cross-account reads, writes, scans and deletes fail |
| Subscription bypass | Server-confirmed entitlements and quotas; reconciliation and idempotent billing events | Expiry, refund, downgrade and delayed webhook scenarios preserve access boundaries |
| Provider outage presented as safety | Explicit provider error states; retain prior successful findings | Timeouts, throttling and invalid responses never become zero breaches |
| Secret or personal-data leakage | Server-only keys; minimal encrypted data; redacted logs and telemetry | Inspect logs, responses, builds and push payloads for sensitive values |
| Duplicate or stale notifications | Stable finding keys; idempotent jobs; current consent/eligibility checks | Retries do not duplicate alerts; deleted/revoked accounts cannot be notified |
| Deletion race | Revoke sessions and disable work before deleting data; jobs re-check eligibility | Queued scans and pushes cannot resurrect deleted data |

Sensitive assets include verified addresses, session material, minimal breach findings, APNs tokens, encryption/HMAC keys and provider credentials. Assess each boundary described in [architecture](ARCHITECTURE.md). Do not collect passwords or raw stolen credentials.

Before a public deployment, expand this document with actual authentication, cryptography, storage, retention, provider and operational designs, then test those implementations. A local smoke check is not a security review.

## Implemented checks and remaining boundaries

Offline tests use real SQLite and fictional email/XON transports. They cover consent, failed delivery, missing transport, five-attempt codes, expiry/replay/device mismatch, unauthenticated and cross-account access, premium gating, rate limits, preserved scan results on provider errors, refresh replay, logout and account deletion. No runtime fixture or verification bypass exists.

The Worker is loopback-only and rejects staging/production. IP limits are a development defence, not device attestation or a production anti-abuse perimeter. Cleanup is lazy, not a scheduled retention job. A security review, key rotation, backups, production edge controls and delivery/bounce operations are still required before launch. Wrangler local explorer/observability and outbound traces are disabled to avoid recording provider URLs containing emails.
