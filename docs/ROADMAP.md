# Roadmap

## Implemented local vertical slice

- Reproducible npm/XcodeGen setup and local D1 migrations.
- Plain native iOS interface with `app.cybrguard` bundle identifier.
- Real Cloudflare email adapter for `security@cybrguard.app`; inbox delivery and ownership verification confirmed in local simulator testing.
- Six-digit codes displayed as `XXX-XXX`, expiring, hashed and single-use with throttling.
- Encrypted verified address, consent record, hashed device-bound rotating sessions and iOS Keychain storage.
- Paid XON adapter, real free breach count/timestamp, ownership checks, explicit provider errors, retry limits and preservation of prior results.
- Premium-gated detailed findings, encrypted metadata, password-storage risk highlights and persistent self-reported remediation marks. Staging testers can be granted explicit server access while billing is pending.
- Logout and account deletion, including deletion/scan race protection.
- Offline SQLite/network/security tests and explicit reserved-address live XON smoke tests.

## Next integration checks

Real mailbox delivery, verification, signed-in session persistence and the paid scan have passed end to end in the simulator, with a result screenshot captured. API checks (75 tests), Swift core tests (20 tests), signed simulator build and six reserved-address live provider checks passed.

1. Confirm complete XON storage/cache permissions and purchased quota/burst limits in the provider console.
2. Test on a signed physical iPhone using the deployed HTTPS staging backend at `api.cybrguard.app`. Staging has an isolated D1 database and keys, tester-only sign-in, and verified HTTPS health/access controls.

## M2 — subscriptions and premium details

RevenueCat/StoreKit products, localised prices/trial terms, restore purchases, authenticated idempotent webhooks and entitlement reconciliation. Server-enforced quotas/downgrades, independently verified additional addresses, billing-backed entitlement reconciliation. Detailed findings and remediation are implemented with server gating and staging test grants; paid purchases are not connected.

## M3 — monitoring and notifications

Cron + Queues, configurable daily cadence, purchased-rate-limit-aware scheduling, deduplication and retries, initial historical baseline, and APNs consent/device revocation. Discreet alerts only for newly observed findings. These are not live today.

## M4 — release readiness

Isolated staging/production resources, abuse hardening, scheduled retention, encryption/key rotation and backups, email bounce/suppression operations, privacy/terms and App Store disclosures, security/accessibility review, signed device/TestFlight verification and release procedures.

## Future integrations

Hexproof alias management and Squizz browser-warning correlation need explicit contracts, opt-in and privacy boundaries before implementation. No VPN, generic AI assistant or browser extension is in the MVP.
