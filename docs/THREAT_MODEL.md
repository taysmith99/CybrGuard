# Threat model

This is an implementation checklist for future milestones, not a security certification. The M0 starter exposes service health only. It has no identity, scan, subscription or account-deletion implementation.

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

Future sensitive assets include verified addresses, session material, minimal breach findings, APNs tokens, encryption/HMAC keys and provider credentials. Assess each boundary described in [architecture](ARCHITECTURE.md). Do not collect passwords or raw stolen credentials.

Before a public deployment, expand this document with actual authentication, cryptography, storage, retention, provider and operational designs, then test those implementations. A local smoke check is not a security review.
