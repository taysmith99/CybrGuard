# Development and operations

## Local setup and secrets

Run the root README commands. The Worker uses a local D1 database and is bound to `127.0.0.1:8788`. `db:migrate:local` always selects `--local`. Restricted staging has a separate remote D1 database and HTTPS custom domain; local commands still operate only on local data.

`npm run dev:setup` reads the ignored root `.env` without executing it. Supported variables: `XON_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_TOKEN` (mapped to Worker secret `CLOUDFLARE_EMAIL_API_TOKEN`), `CLOUDFLARE_EMAIL_API_TOKEN`, and `EMAIL_FROM`. It copies only supported values to ignored `apps/api/.dev.vars`, preserves/generates encryption/HMAC keys and sets mode `live` if an XON key is present. Configuration is written with mode 0600 and values are never printed. Restart Wrangler after re-running setup. Do not delete/rotate generated keys without a data migration; existing protected emails would become unreadable or unfindable.

The latest migration creates users, encrypted monitored email/consent records, hashed single-use verification challenges, hashed device-bound session credentials, shared rate limits and count/timestamp storage. Schema version 4 adds premium entitlements, encrypted normalised findings, remediation timestamps and a separate detailed-scan timestamp. Billing/webhooks and job/device tables remain unimplemented.

## Cloudflare Email Service

The selected domain is **cybrguard.app** and sender is **security@cybrguard.app**. The selected provider is Cloudflare Email Service, not Resend.

1. Activate the domain in the correct Cloudflare account.
2. Enable outbound **Email Sending**, confirm account eligibility and add the DNS/DKIM/SPF records supplied by Cloudflare. Email Routing does not by itself enable unrestricted transactional sends.
3. Create an account token with email sending permission and any required recipient/sending-domain scope. Store it as `CLOUDFLARE_EMAIL_TOKEN` in root `.env` together with `CLOUDFLARE_ACCOUNT_ID`.
4. Run `npm run dev:setup` and restart `npm run dev:api`.
5. Request a verification code from the app, check the real inbox/junk folder and enter the code. A Cloudflare acceptance/queued response is not proof of inbox delivery; complete this check end to end.

Local mode uses the documented REST API, `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`, with a bearer token. The API acknowledges recipient delivery/queue acceptance before a challenge is returned. Failures invalidate the challenge and return a sanitised error, with no raw Cloudflare messages or recipient data in logs.

The adapter also supports a structured `EMAIL.send()` Worker binding when `EMAIL_TRANSPORT=cloudflare-binding`. This is for a real deployed binding or an explicitly configured `remote: true` email binding. Never select that mode with Wrangler's simulated local email binding: the simulator logs/saves message content and does not prove mailbox ownership. No such binding is configured by default, and there is no local inbox/OTP bypass.

Official references: [Email REST API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/), [Worker binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [remote email development](https://developers.cloudflare.com/email-service/local-development/sending/).

## XON and rate limits

The API calls only the fixed HTTPS origin `plus-api.xposedornot.com`, with the server-side key and `detailed=false` for free accounts or `detailed=true` after server-side premium checks. It validates success/envelope/address/unique breach IDs and retains the count/timestamp plus encrypted minimal finding details for premium scans. Redirects, timeouts, bad payloads, auth failures, 404s and rate limits are never treated as clean results. No raw breach payload is logged or stored. The development command disables Wrangler local explorer and local observability, and Wrangler configuration disables trace collection, because outbound XON URLs contain an email address. Preserve these safeguards when changing tooling; before enabling telemetry, verify upstream paths and credentials are redacted.

The global gate permits at most one request per 1.5 seconds and respects `detail.retry_after` from 429 responses. Each verified address may attempt one scan/minute. Confirm the purchased quota/burst rate before multi-user deployment; these conservative development defaults are not a statement of the vendor's contract. Automatic monitoring/queue retries are not implemented.

Official [OpenAPI](https://plus-api.xposedornot.com/openapi.json) and [quickstart](https://plus.xposedornot.com/blog/xonapi-quickstart) were checked during implementation. The served OpenAPI still references missing response components, so parsing uses the documented simple response and the reserved-address smoke suite. Complete caching/storage terms, purchased rate limits and webhook availability require confirmation in the vendor console. Premium details are normalised and encrypted; raw payloads, logos, record counts, actual passwords and stolen credentials are not retained. Consumer licensing remains the owner's documented assumption.

## Sessions, retention and deletion

Email encryption uses AES-256-GCM with a fresh IV. Lookups and OTP hashes use a separate HMAC key. Access/refresh/device tokens are SHA-256 hashed in D1. Access expires in 15 minutes; refresh rotates and has a fixed 30-day family expiry. Reuse revokes the family. The app stores credentials in non-synchronising, device-only Keychain storage scoped to origin/environment. Simulator app builds must use normal local ad-hoc signing; explicitly unsigned simulator apps cannot access Keychain.

Verification challenges expire after 10 minutes. Sign-in requests lazily remove challenges more than an hour past expiry, sessions more than a day past family expiry, and abuse counters older than 24 hours. This is development cleanup, not a production scheduled retention system. Account deletion immediately deletes challenges for the email, then the account and cascading email/count/sessions. Shared pseudonymous abuse counters may remain for up to 24 hours. It does not remove upstream historical breach records or Cloudflare mail-delivery records.

## Staging deployment

The Worker `cybrguard-api-staging` serves **https://api.cybrguard.app**, using D1 `cybrguard-staging`. Production runtime remains blocked. Public workers.dev and preview URLs and request tracing remain disabled. Staging accepts only the HTTPS custom domain and sign-in emails listed in the `STAGING_ALLOWED_EMAILS` secret. This is a small tester environment, not an open public launch.

Store the deployment token as `CLOUDFLARE_API_TOKEN` in ignored root `.env`; the script can also use the existing `CLOUDFLARE_EMAIL_TOKEN` if its permissions have been expanded. Required scopes: **Account Workers Scripts Edit and D1 Edit; Zone Workers Routes Edit, Zone Read and DNS Edit**, limited to the intended account and `cybrguard.app`. Outbound Email Sending permission remains required for the runtime email token. The deployment credential is never uploaded under `CLOUDFLARE_API_TOKEN` to the Worker.

Run `npm run check`, then `npm run deploy:staging`. The command checks zone/account visibility, creates or reuses only `cybrguard-staging`, applies remote migrations, and deploys the custom domain and runtime secrets. It does not touch other Workers/databases. Cloudflare manages DNS and the custom-domain HTTPS certificate. Verify `GET /v1/health` returns 200 with `environment: staging` and `dataMode: live`; DNS/certificate propagation can outlast the upload command, so check again if upload succeeds but initial health lookup fails. Never disable certificate validation.

Independent staging encryption/HMAC keys, runtime credentials and tester allowlist are persisted in ignored `.env.staging` with mode 0600. Back this up securely; do not replace keys on redeploy. If a staging database already exists and the file is missing, the script stops instead of generating incompatible keys. Edit the allowlist in `.env.staging` for subsequent deployments. The local `.dev.vars` keys/database and sessions are unchanged. A first staging sign-in requires a new real verification code.

For iPhone testing, copy `apps/ios/Config/Staging.xcconfig.example` to ignored `apps/ios/Config/Local.xcconfig`, add your Apple signing team, regenerate the project and run from Xcode on the connected phone. The app uses `https://api.cybrguard.app` and `API_ENVIRONMENT=staging`; no server secrets enter the app.

Verified deployment checks: trusted HTTPS health 200, no-store and HSTS headers, unauthenticated account 401, unapproved email 403 without sending mail, and invalid challenge 400. Actual mailbox verification/scan must still be completed independently against staging; local simulator results are not staging results.

`npm run build:api` remains a local dry run. Before production: establish separate production resources, backups, perimeter/abuse controls, scheduled retention, key rotation, consent/legal notices, email delivery operations and operational incident procedures. App Store/RevenueCat/APNs setup remains on the roadmap; staging does not implement purchases, scheduled monitoring or push notifications.

## Premium test access

`STAGING_PREMIUM_EMAILS` in ignored `.env.staging` is uploaded as a Worker secret. It grants verified tester accounts access to detailed scans only in staging. It does not skip OTP ownership checks. A new scan is required to populate details from count-only history. The development simulator tester has a seven-day local entitlement for testing; production remains disabled and no payment is implied. Future authenticated billing reconciliation must populate/expire `premium_entitlements` before purchases can be offered. No client premium flag is accepted.

Findings are matched by an address-specific keyed breach index and stored as AES-GCM encrypted metadata. Remediation timestamps survive refreshes, rescans and disappearing/reappearing records; deletion cascades all finding and entitlement rows. Marking a finding remediated cannot verify a password change or erase a historical exposure.

## Daily monitoring

Staging deployment creates/reuses the isolated `cybrguard-monitoring-staging` queue; the deployment token needs Queues Read/Edit as well as Workers/D1 permissions. Wrangler binds its producer and consumer to the API Worker, consumer concurrency one, batch size one, ten queue retries, plus the application-level limit of eight durable scan attempts. The `*/15 * * * *` Cron dispatches opted-in due addresses; the per-address cadence is 24 hours. Production remains blocked.

Local testing: run `npm run dev --workspace @cybrguard/api -- --test-scheduled`, enable monitoring in the simulator, then `curl 'http://localhost:8788/__scheduled?cron=%2A%2F15%20%2A%20%2A%20%2A%20%2A'`. This invokes local Cron and the local Queue; it uses the real configured provider and independently verified addresses. Disable monitoring after a temporary test. The test endpoint is Wrangler-local, not a deployed API route.

Inspect D1 `monitoring_jobs` status/attempts/outcome and `monitored_emails.last_monitoring_at`, `next_check_at`, `last_monitoring_outcome` for operational health, using only aggregate queries in shared logs. Failed jobs do not clear prior results; provider 429 extends the global backoff. Job records contain opaque address IDs, not email plaintext. Push and email breach alerts are not sent by this milestone.
