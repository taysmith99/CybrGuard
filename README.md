# CybrGuard

Development foundation for **CybrGuard**, a native iPhone breach-monitoring app with a Cloudflare Workers API. The product brief and implementation requirements are in [AGENTS.md](AGENTS.md).

**Current milestone: M0 — repository scaffolding.** The API exposes a health endpoint and the SwiftUI starter can check it. There are no email verification, breach scans, subscriptions, scheduled monitoring or push notifications yet. `dataMode: "unconfigured"` is deliberate: a successful health check is not a breach result or a test of external providers. This repository is not ready for production deployment.

## Local API setup

Use Node 24.20.0, npm 11.19.0, and Git. The Node version is recorded in [.nvmrc](.nvmrc). A Cloudflare account or provider key is not needed for the local foundation. Wrangler is a repository dependency; no global install is required.

Run from the repository root:

```sh
# If using nvm:
nvm install
nvm use

npm ci
npm run dev:setup
npm run db:migrate:local
npm run check
npm run build:api
npm run dev:api
```

In another terminal:

```sh
curl --fail http://127.0.0.1:8788/v1/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "cybrguard-api",
  "environment": "development",
  "dataMode": "unconfigured"
}
```

`dev:setup` copies `.dev.vars.example` to the ignored `apps/api/.dev.vars` if it does not already exist. Keep secrets out of source control and chat. `db:migrate:local` uses Wrangler's local database, and `build:api` performs a dry run without deploying. The local database is only a migration foundation; the product data model remains future work. See [operations](docs/OPERATIONS.md) for environment boundaries and troubleshooting.

## iOS setup on macOS

Install the full [Xcode application](https://developer.apple.com/xcode/) (16 or later) and an iOS simulator runtime, then open Xcode once to finish its component installation. The starter targets iOS 17 or later and Swift 6. Apple's Command Line Tools alone cannot build the iOS application. Install [XcodeGen](https://github.com/yonaskolb/XcodeGen) 2.46.0 or later using your preferred installation method; with Homebrew:

```sh
brew install xcodegen
npm run ios:generate
open apps/ios/Exposure.xcodeproj
```

The iOS project and scheme still use the technical name `Exposure`. See [the iOS guide](apps/ios/README.md) for the generated project, simulator run instructions, display-name and API URL configuration, and test commands. Start the local API before checking its health in the app. The starter makes no provider queries and needs no signing account for simulator development.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the dependency versions in the lockfile |
| `npm run dev:setup` | Create missing local configuration files |
| `npm run dev:api` | Run the API locally |
| `npm run db:migrate:local` | Apply local D1 migrations |
| `npm run check` | Check formatting, lint, TypeScript and tests |
| `npm run build:api` | Bundle the Worker without deploying |
| `npm run ios:generate` | Generate the Xcode project from its specification |
| `npm run test:ios:core` | Run the Swift package tests without the simulator UI |
| `npm run test:xon` | Run explicit live XON smoke checks using the ignored root `.env` |

The JavaScript checks do not replace building and testing the iOS target with Xcode.

The optional [XON smoke suite](docs/XON_TESTING.md) checks the configured provider key with reserved test addresses. It runs separately from the normal checks and CI, and does not enable breach scanning in the app.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/api` | Hono Worker, local D1 configuration and migrations |
| `apps/ios` | SwiftUI starter and reproducible XcodeGen project specification |
| `packages/contracts` | Shared API response schemas |
| `docs` | Architecture, API, operations and implementation requirements |

Read [architecture](docs/ARCHITECTURE.md), [current API](docs/API.md), and [roadmap](docs/ROADMAP.md) before implementing product features. [Threat model](docs/THREAT_MODEL.md), [privacy](docs/PRIVACY.md), and [billing](docs/BILLING.md) record requirements; they do not claim those controls are implemented.

## Accounts and manual prerequisites for later milestones

- **Cloudflare:** deployment account, separate staging/production D1 databases, and later Queues, Cron Triggers and outbound email configuration.
- **xonAPI+:** a paid provider account, server-side key, documented response schema and purchased rate limits. The project assumes the owner's licence permits this consumer use; that is an assumption, not a legal conclusion.
- **Email:** a controlled sender domain, verified sending and SPF/DKIM configuration. Confirm outbound Cloudflare Email Service availability in the target account or choose an adapter-backed fallback.
- **Apple:** developer team, final bundle identifier, signing and App Store Connect configuration; APNs credentials for notifications.
- **RevenueCat:** project linked to App Store Connect, sandbox products, offerings, entitlement mapping and an authenticated backend webhook.
- **Release:** consent and deletion flows, reviewed privacy policy and terms, App Store disclosures, accessibility and security verification.

The steps and outstanding implementation gates are in [operations](docs/OPERATIONS.md). No external integration is live in this starter. No repository licence has been selected; the owner must choose one before adding a `LICENSE` file.
