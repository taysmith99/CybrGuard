# Development and operations

## Local setup and secrets

Run the root README commands. The Worker uses a local D1 database and is bound to `127.0.0.1:8788`. `db:migrate:local` always selects `--local`. No remote database or public API route has been provisioned.

`npm run dev:setup` reads the ignored root `.env` without executing it. Supported variables: `XON_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_TOKEN` (mapped to Worker secret `CLOUDFLARE_EMAIL_API_TOKEN`), `CLOUDFLARE_EMAIL_API_TOKEN`, and `EMAIL_FROM`. It copies only supported values to ignored `apps/api/.dev.vars`, preserves/generates encryption/HMAC keys and sets mode `live` if an XON key is present. Configuration is written with mode 0600 and values are never printed. Restart Wrangler after re-running setup. Do not delete/rotate generated keys without a data migration; existing protected emails would become unreadable or unfindable.

The latest migration creates users, encrypted monitored email/consent records, hashed single-use verification challenges, hashed device-bound session credentials, shared rate limits and count/timestamp storage. It does not create premium finding metadata or billing/job/device tables.

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

The API calls only the fixed HTTPS origin `plus-api.xposedornot.com`, with the server-side key and `detailed=false`. It validates success/envelope/address/unique breach IDs and retains only the count and last successful timestamp. Redirects, timeouts, bad payloads, auth failures, 404s and rate limits are never treated as clean results. No raw breach payload is logged or stored. The development command disables Wrangler local explorer and local observability, and Wrangler configuration disables trace collection, because outbound XON URLs contain an email address. Preserve these safeguards when changing tooling; before enabling telemetry, verify upstream paths and credentials are redacted.

The global gate permits at most one request per 1.5 seconds and respects `detail.retry_after` from 429 responses. Each verified address may attempt one scan/minute. Confirm the purchased quota/burst rate before multi-user deployment; these conservative development defaults are not a statement of the vendor's contract. Automatic monitoring/queue retries are not implemented.

Official [OpenAPI](https://plus-api.xposedornot.com/openapi.json) and [quickstart](https://plus.xposedornot.com/blog/xonapi-quickstart) were checked during implementation. The served OpenAPI still references missing response components, so parsing uses the documented simple response and the reserved-address smoke suite. Complete caching/storage terms, purchased rate limits and webhook availability require confirmation in the vendor console. Detailed metadata is intentionally not collected here; the only retained scan data is count/timestamp. Consumer licensing remains the owner's documented assumption.

## Sessions, retention and deletion

Email encryption uses AES-256-GCM with a fresh IV. Lookups and OTP hashes use a separate HMAC key. Access/refresh/device tokens are SHA-256 hashed in D1. Access expires in 15 minutes; refresh rotates and has a fixed 30-day family expiry. Reuse revokes the family. The app stores credentials in non-synchronising, device-only Keychain storage scoped to origin/environment. Simulator app builds must use normal local ad-hoc signing; explicitly unsigned simulator apps cannot access Keychain.

Verification challenges expire after 10 minutes. Sign-in requests lazily remove challenges more than an hour past expiry, sessions more than a day past family expiry, and abuse counters older than 24 hours. This is development cleanup, not a production scheduled retention system. Account deletion immediately deletes challenges for the email, then the account and cascading email/count/sessions. Shared pseudonymous abuse counters may remain for up to 24 hours. It does not remove upstream historical breach records or Cloudflare mail-delivery records.

## Environment and deployment gate

| Concern | Development | Staging/production |
| --- | --- | --- |
| Worker/API | Local loopback | Runtime blocked; not provisioned |
| D1 | Local migrations | Separate databases required |
| Secrets | Ignored `.dev.vars` | Cloudflare secrets and rotation plan required |
| Email | Real Cloudflare REST when configured | Sender/account readiness and delivery verification required |
| XON | Real paid API after verification | Contract/rate/privacy review required |
| Billing/monitoring/APNs | Not implemented | Required before advertising these features |

`npm run build:api` is a dry run only. Wrangler disables public `workers.dev`/preview routes and no deployment command has been added. A physical iPhone needs a trusted HTTPS development/staging endpoint; changing to a LAN HTTP origin is intentionally rejected by the app. Do not claim an iPhone backend or live production service exists until it has been explicitly provisioned and verified.

Before enabling deployment: establish separate environments, correct bindings/backups, production rate/perimeter controls, scheduled retention and key rotation, consent/legal notices, email delivery handling, monitoring/observability and operational incident procedures. Later App Store/RevenueCat/APNs setup is described in the roadmap/billing guide.
