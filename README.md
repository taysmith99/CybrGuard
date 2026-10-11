# CybrGuard

A plain SwiftUI iPhone app with a local Cloudflare Workers API and paid **xonAPI+** breach counts. The implementation brief is in [AGENTS.md](AGENTS.md).

**Current state:** email ownership verification, device-bound sessions, manual breach counts, local D1 persistence, sign-out and account deletion are connected. Verification mail uses **Cloudflare Email Service**, from `security@cybrguard.app`. XON queries run on the server only, after successful verification and consent. No fake breach data or verification bypass is used by the running app.

Subscriptions, premium breach details, additional addresses, scheduled monitoring and push notifications remain unimplemented. Staging/production serving is deliberately blocked; this is a local development vertical slice, not a release-ready service.

## Local development

Use the pinned Node 24.20.0 and npm 11.19.0. In this repository:

```sh
npm ci
# Copy .env.example to .env if needed, then add credentials privately.
npm run dev:setup
npm run db:migrate:local
npm run check
npm run build:api
npm run dev:api
```

The ignored root `.env` supports:

```dotenv
XON_API_KEY=your_paid_key
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_EMAIL_TOKEN=your_account_email_sending_token
EMAIL_FROM=security@cybrguard.app
```

Never commit these values. `dev:setup` copies supported credentials into ignored `apps/api/.dev.vars` with private permissions, generates persistent local encryption/HMAC keys on first use, and never prints secret values. Re-run it after changing `.env`, then restart the API. Keep the generated encryption and HMAC keys if you want to retain access to existing local data.

With a configured XON key, [the health endpoint](http://localhost:8788/v1/health) returns `dataMode: "live"`. This means live scan mode is configured, not that mail delivery or provider credentials have been verified. Without a key it returns `unconfigured` and refuses account/scan routes.

## Cloudflare email prerequisites

1. Add `cybrguard.app` to the intended Cloudflare account and finish nameserver activation.
2. Enable **Email Service → Email Sending** for the domain, including the sending DNS/DKIM/SPF records shown by Cloudflare. Incoming Email Routing alone is insufficient.
3. Use an account token with outbound Email Sending permission. The local backend sends real emails through Cloudflare's REST API; no simulated local email binding is used.
4. Configure the values above and run `npm run dev:setup`.

The token can be limited to email sending; zone-list access is not required. Cloudflare account eligibility, recipient restrictions and sending limits still apply. See [operations](docs/OPERATIONS.md).

## Run on the iPhone simulator

Full Xcode and an iOS simulator runtime are required. XcodeGen 2.46.0 or later generates the project:

```sh
npm run ios:generate
open -a Xcode apps/ios/Exposure.xcodeproj
```

Select the **Exposure** scheme and an iPhone simulator, then press **⌘R**. The app is displayed as **CybrGuard**, with bundle identifier **`app.cybrguard`**. The project and scheme retain the technical name `Exposure`.

Keep `npm run dev:api` running. Tap **Get started / Sign in**, enter your address, consent, and request a code. Enter the six-digit (XXX-XXX) code from your inbox within 10 minutes. Once verified, tap **Scan verified email**. The free result shows the provider's real count and last successful scan time. Errors never become zero-breach results.

A physical iPhone requires an Apple signing team and a reachable HTTPS backend; its `localhost` points to the phone itself. No remote backend has been provisioned or deployed. See [iOS setup](apps/ios/README.md).

## Checks

| Command | Purpose |
| --- | --- |
| `npm run check` | Formatting, lint, TypeScript and offline backend/security tests |
| `npm run build:api` | Worker bundle dry run; never deploys |
| `npm run test:ios:core` | Swift core networking/configuration tests |
| `npm run test:xon` | Explicit live XON smoke checks against reserved test addresses |
| `npm run db:migrate:local` | Local D1 migrations only |

If Command Line Tools are selected globally, prefix Swift/Xcode commands with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

Backend tests use real SQLite with fictional email/provider transports. This test-only injection does not create a runtime mock mode. The optional [XON smoke suite](docs/XON_TESTING.md) consumes a small amount of provider quota; it does not run in normal checks or CI.

## Repository map and release prerequisites

- `apps/ios`: SwiftUI app, API client and Keychain-backed sessions.
- `apps/api`: Worker routes, encryption, Cloudflare email/XON adapters and D1 migrations.
- `packages/contracts`: shared request/response schemas and OpenAPI.
- `docs`: [API](docs/API.md), [architecture](docs/ARCHITECTURE.md), [operations](docs/OPERATIONS.md), [threat model](docs/THREAT_MODEL.md), [privacy](docs/PRIVACY.md), [billing](docs/BILLING.md) and [roadmap](docs/ROADMAP.md).

Before release: provision isolated staging/production resources, verify sending and provider terms/rate limits, configure App Store/RevenueCat, implement premium/quota enforcement and monitoring/APNs, complete security/accessibility review, and finalise privacy/terms. The project assumes the owner's paid XON licence permits this consumer use; this is an assumption, not a legal conclusion. No repository licence has been selected.
