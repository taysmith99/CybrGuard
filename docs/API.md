# Current API

Base URL for local development: `http://localhost:8788`. JSON requests/responses use `Cache-Control: no-store` and server-generated `X-Request-ID`. Errors contain `{ "error": { "code", "message", "requestId" } }`; rate limits also set `Retry-After` in seconds. Validation errors never echo request bodies. Requests are limited to 4 KiB.

All account routes require `DATA_MODE=live`, persistent encryption/HMAC keys and an XON key. Staging is available at `https://api.cybrguard.app`; it requires live configuration, Cloudflare sending configuration and the `STAGING_ALLOWED_EMAILS` secret. Staging accepts only its HTTPS origin and rejects unapproved sign-in emails with 403 `forbidden`. Production remains blocked. Health accepts unconfigured development mode.

## Verification and sessions

- `POST /v1/auth/start`: `{ email, consent: true, deviceId }`. `deviceId` is a 64-character random hexadecimal value stored in Keychain. Sends a real Cloudflare email and returns HTTP 202 `{ challengeId, expiresIn: 600, message }`. Existing/new users have the same flow. Delivery/configuration failures return 503; no code is returned, logged or made available through a development endpoint.
- `POST /v1/auth/verify`: `{ challengeId, code, deviceId }`. The six-digit (XXX-XXX) code expires after 10 minutes, is keyed-hashed at rest, permits five guesses and is atomically consumed once. Returns `{ accessToken, refreshToken, expiresAt }`. Successful verification creates or reuses the account and its primary independently verified address.
- `POST /v1/auth/refresh`: `{ refreshToken, deviceId }`. Rotates both tokens; old access is revoked. Replaying an old refresh token revokes its entire token family. Access lasts 15 minutes; the family lasts at most 30 days from login.
- `POST /v1/auth/logout`: authenticated; revokes the current token family, HTTP 204.

Every authenticated call sends `Authorization: Bearer <accessToken>` and `X-Device-ID: <deviceId>`. Tokens are random and hashed in D1, not JWTs or client-supplied user IDs. The native client refreshes credentials and stores them in Keychain, scoped to its backend origin/environment.

## Account and scans

- `GET /v1/me`: `{ userId, tier: "free" | "premium", quota: 1–25, address }`.
- `GET /v1/addresses`: `{ addresses: [address], quota }`.
- `GET /v1/addresses/:id/summary`: owned verified address summary.
- `POST /v1/addresses/:id/scan`: calls paid XON with the stored verified address; accepts no email or user ID from the caller. Returns an address summary with a real count/timestamp. One attempt per address per minute, one in-flight scan, and a global provider gate apply. A 429 provider response adds shared backoff. Manual retries are explicit; manual scans do not retry automatically. Scheduled monitoring uses the Queue described below.
- `GET /v1/addresses/:id/findings`: returns `{ findings, checkedAt }` for the owned address with server-confirmed premium access; otherwise 403 `subscription_required`. The timestamp is the last detailed scan, independently of free count scans.
- `PATCH /v1/addresses/:id/findings/:findingId`: `{ remediated: boolean }`, with the same ownership/premium checks. Returns the updated findings. Repeated true updates preserve the original remediation timestamp; false clears it. This is a user-reported action, not confirmation of an external password change.
- `DELETE /v1/me`: deletes the account and cascades stored email, summary and sessions; invalidates outstanding challenges for that address. HTTP 204. A concurrent scan cannot recreate deleted data.

An address summary is `{ id, email, verified: true, isPrimary: boolean, knownBreachCount: integer | null, checkedAt: ISO8601 | null }`. `null` means no successful scan; zero means a successful provider result with no known matches. Provider failures preserve prior counts/timestamps. Free scans request `detailed=false` and never collect metadata. Premium scans request `detailed=true`, validate/normalise fields and encrypt finding details at rest. IDs and remediation marks survive rescans; failed scans preserve previous findings. Only active findings are returned; reappearing findings retain prior marks. Plaintext and easy-to-crack password storage are highlighted; unknown risk is not labelled safe.

## Abuse controls

Sending limits: five requests per email/hour, one per email/minute, ten per device/hour and twenty per coarse IP/hour. Verification requests additionally have a thirty-per-device/hour budget, besides five attempts per challenge. Refresh has sixty-per-device/hour. Identifiers used in counters are HMACs or hashes. Expired counters are lazily removed after 24 hours. The local server only listens on loopback; production perimeter/abuse hardening remains a release gate.

## Not implemented

Device registration and push routes are not implemented. Billing adapters and webhook/reconciliation routes are implemented but require Apple/RevenueCat account configuration before real purchases. The OpenAPI document only lists current routes. See the roadmap for later milestones.

## Premium authorisation

The client cannot grant premium. The backend checks an unexpired `premium_entitlements` row; authenticated reconciliation and authenticated RevenueCat webhooks write entitlements only after a fresh provider lookup. Missing billing credentials leave those routes unavailable. Staging additionally supports a server-secret `STAGING_PREMIUM_EMAILS` allowlist, honoured only in staging and still requiring independent email verification. This is test access, not a purchased subscription. Free quota is one; administrative premium entitlement quotas default to three, and are bounded to 25. Staging test access defaults to three. Account deletion cascades findings, remediation marks and entitlements.

## Remediation checklist

Findings include `remediationSteps: [{ id, title, detail, completedAt }]`. Guidance is deterministic and based only on exposed data categories and reported password risk. `PATCH /v1/addresses/:id/findings/:findingId/actions/:actionId` with `{ completed: boolean }` saves/undoes a step with ownership and premium checks. Only currently applicable step IDs are accepted. Step completion does not automatically mark a finding remediated. Timestamps survive rescans and cascade on deletion.

## Additional addresses and session controls

- `POST /v1/addresses/verify/start`: authenticated `{ email, consent: true, deviceId }`. Requires current premium access, remaining quota and a device matching the current session. Uses the same delivery limits and real six-digit code as login.
- `POST /v1/addresses/verify/complete`: authenticated `{ challengeId, code, deviceId }`. Challenges are bound to purpose, account and device. Ten-minute expiry, five attempts and single use apply. Atomic insertion enforces concurrent quota redemption. HTTP 201 address summary; quota/conflicting ownership failures never attach the address. Additional verification never creates a session or grants access to the primary account.
- `DELETE /v1/addresses/:id`: removes an owned additional email and cascades its findings/actions. HTTP 204. Primary-address removal requires account deletion. Paused excess addresses can still be removed after downgrade.
- Address ordering is primary first, then verification time and ID. Only the first quota addresses may scan or access premium details; extra stored addresses remain visible and paused after downgrade.
- `GET /v1/sessions`: authenticated `{ sessions: [{ id, current, expiresAt }] }`; each opaque ID represents an active login family, including its rotated tokens. Device names/locations are not collected.
- `DELETE /v1/sessions/:id`: revokes an owned login family. HTTP 204 or 404.
- `POST /v1/sessions/revoke-others`: revokes all other login families for the account. HTTP 204; current sign-in remains active.
- Account deletion invalidates challenges for every stored email and cascades account-bound additional-address challenges.

## Opt-in daily monitoring

- `GET /v1/addresses/:id/monitoring`: owned address `{ enabled, paused, cadenceHours: 24, lastCheckedAt, nextCheckAt, outcome, pushAvailable: false }`. `nextCheckAt` uses Unix seconds. Plan expiry/excess quota pauses work without hiding the stored preference.
- `PATCH /v1/addresses/:id/monitoring`: `{ enabled: boolean }`, HTTP 204. Enabling requires premium access, an active quota slot and Queue configuration. Disabling remains available after downgrade. Each preference change advances a generation to invalidate queued/in-flight work.
- Cron runs every 15 minutes, selects due verified opted-in addresses, checks premium/quota and enqueues opaque job IDs. Consumer concurrency is one, with a shared upstream rate gate also used by manual scans. Successful checks schedule the next daily check. Temporary failures retry with backoff; after eight durable attempts the job fails and another daily attempt can follow.
- Jobs deduplicate by address, preference generation and scheduled time. Stalled dispatches are recovered after 15 minutes; completed duplicate deliveries do no provider work. Deletion cascades jobs. Disabled/deleted/over-quota addresses are rechecked before scanning; preference generation and scan lease guard persistence after the provider returns.
- The first detailed scan establishes a historical baseline. Later unseen provider IDs receive `isNew: true`; repeated IDs retain original identity/progress. Marking a finding remediated clears its new badge. No notification delivery is implied.

## Billing

- `GET /v1/billing`: authenticated `{ configured, plan: "free" | "personal" | "family", expiresAt, verifiedAt }`. Unix timestamps are nullable. Stale/expired confirmation reports free. Administrative staging tester access is separate from purchased subscription status.
- `POST /v1/billing/reconcile`: authenticated, no client entitlement fields; fresh RevenueCat v2 active-entitlement lookup (or legacy v1 subscriber lookup) for the authenticated account UUID, HTTP 204. Twelve requests/account/hour. Provider failure preserves the previous confirmed snapshot.
- `POST /v1/billing/revenuecat/webhook`: server-to-server, exact configured Authorization header, matching app ID and SANDBOX events only. Event IDs deduplicate after successful processing. Returns HTTP 200 `{ received: true }`. Refunds/expiry/transfer/cancellation use fresh subscriber snapshots, never a client/event premium flag. Missing configuration returns 503. Invalid authentication returns 401; wrong app/environment returns 403.
- Billing snapshots refresh after six hours through Cron; access freshness is capped at 24 hours and confirmed entitlement expiry. Downgrades retain addresses while pausing extra slots. See `BILLING.md` for exact configuration and manual sandbox release checks.
