# Current API

Base URL for local development: `http://localhost:8788`. JSON requests/responses use `Cache-Control: no-store` and server-generated `X-Request-ID`. Errors contain `{ "error": { "code", "message", "requestId" } }`; rate limits also set `Retry-After` in seconds. Validation errors never echo request bodies. Requests are limited to 4 KiB.

All account routes require `DATA_MODE=live`, persistent encryption/HMAC keys and an XON key. Staging is available at `https://api.cybrguard.app`; it requires live configuration, Cloudflare sending configuration and the `STAGING_ALLOWED_EMAILS` secret. Staging accepts only its HTTPS origin and rejects unapproved sign-in emails with 403 `forbidden`. Production remains blocked. Health accepts unconfigured development mode.

## Verification and sessions

- `POST /v1/auth/start`: `{ email, consent: true, deviceId }`. `deviceId` is a 64-character random hexadecimal value stored in Keychain. Sends a real Cloudflare email and returns HTTP 202 `{ challengeId, expiresIn: 600, message }`. Existing/new users have the same flow. Delivery/configuration failures return 503; no code is returned, logged or made available through a development endpoint.
- `POST /v1/auth/verify`: `{ challengeId, code, deviceId }`. The six-digit (XXX-XXX) code expires after 10 minutes, is keyed-hashed at rest, permits five guesses and is atomically consumed once. Returns `{ accessToken, refreshToken, expiresAt }`. Successful verification creates or reuses the account and its single independently verified address.
- `POST /v1/auth/refresh`: `{ refreshToken, deviceId }`. Rotates both tokens; old access is revoked. Replaying an old refresh token revokes its entire token family. Access lasts 15 minutes; the family lasts at most 30 days from login.
- `POST /v1/auth/logout`: authenticated; revokes the current token family, HTTP 204.

Every authenticated call sends `Authorization: Bearer <accessToken>` and `X-Device-ID: <deviceId>`. Tokens are random and hashed in D1, not JWTs or client-supplied user IDs. The native client refreshes credentials and stores them in Keychain, scoped to its backend origin/environment.

## Account and scans

- `GET /v1/me`: `{ userId, tier: "free", quota: 1, address }`.
- `GET /v1/addresses`: `{ addresses: [address] }`.
- `GET /v1/addresses/:id/summary`: owned verified address summary.
- `POST /v1/addresses/:id/scan`: calls paid XON with the stored verified address; accepts no email or user ID from the caller. Returns an address summary with a real count/timestamp. One attempt per address per minute, one in-flight scan, and a global provider gate apply. A 429 provider response adds shared backoff. Manual retries are explicit; there is no retry loop or background queue yet.
- `GET /v1/addresses/:id/findings`: ownership checked, then 403 `subscription_required`. Billing/premium detail access is deliberately unavailable rather than trusting a client premium flag.
- `DELETE /v1/me`: deletes the account and cascades stored email, summary and sessions; invalidates outstanding challenges for that address. HTTP 204. A concurrent scan cannot recreate deleted data.

An address summary is `{ id, email, verified: true, knownBreachCount: integer | null, checkedAt: ISO8601 | null }`. `null` means no successful scan; zero means a successful provider result with no known matches. Provider failures preserve prior counts/timestamps. Detailed breach metadata is neither fetched nor persisted in this free vertical slice.

## Abuse controls

Sending limits: five requests per email/hour, one per email/minute, ten per device/hour and twenty per coarse IP/hour. Verification requests additionally have a thirty-per-device/hour budget, besides five attempts per challenge. Refresh has sixty-per-device/hour. Identifiers used in counters are HMACs or hashes. Expired counters are lazily removed after 24 hours. The local server only listens on loopback; production perimeter/abuse hardening remains a release gate.

## Not implemented

Additional-address verification/removal, premium finding status changes, billing webhooks, device registration, scheduled jobs and push routes are not implemented. The OpenAPI document only lists current routes. See the roadmap for later milestones.
