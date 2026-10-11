# AGENTS.md — Consumer Breach Monitoring iOS App

> **Status:** Implementation kickoff specification, October 2026  
> **Working name:** `Exposure` (placeholder; make all branding configurable)  
> **Goal:** Build and commit a production-minded MVP for a direct-to-consumer iPhone subscription app.  
> **Audience:** Individuals and families who want to know where their verified email addresses appeared in known data breaches and be notified of newly detected exposures.  
> **Commercial assumption:** Use the paid [xonAPI+](https://plus.xposedornot.com/products/api) under the user's instruction to assume its licensing permits this consumer product. Keep that assumption documented, rather than making new legal assertions.

## 0. Agent operating instructions

You are the lead engineer and product implementer. **Create the GitHub-ready repository**, not merely a design document. Implement a functioning end-to-end vertical slice with reliable mocks where external credentials are unavailable. Use current stable versions of dependencies and consult official SDK documentation before adopting APIs.

- Do not request credentials in chat or commit secrets. Create `.env.example`, `.dev.vars.example`, setup guides, and clear deployment prerequisites.
- Prefer simple, understandable implementations to premature microservices. Do not introduce generic AI, VPN, or browser-extension features into the MVP.
- Where developer accounts, Xcode signing, Cloudflare bindings, APNs credentials, App Store Connect, RevenueCat configuration or actual API tokens are unavailable, implement adapters/mocks and document the exact manual step required. Never claim those external integrations are live when they are not.
- Use Australian English, AUD prices, privacy-first UX, and accessible UI. Assume an initial Australian launch but design for future internationalisation.
- Use tests and a local development mode with **clearly labelled fictional breach data**. Never substitute mock responses in a production environment.
- At completion, report code created, tests run, what is mocked, and the exact configuration steps needed to ship.

## 1. Product hypothesis and MVP scope

**Core value:** Scan a verified email → see an accurate breach count → subscribe to unlock breach-by-breach details and ongoing monitoring → receive push notifications for new findings → mark findings reviewed / remediated.

### User journey

1. Welcome screen explains what breach monitoring can and cannot detect.
2. User enters an email address and consents to querying the external breach intelligence provider.
3. Send a short-lived verification code or magic link via Cloudflare Email Service. Verify ownership before exposing any account-specific results; rate limit sending and verification.
4. Display a brief real scan UI while the server queries xonAPI+. Do **not** fake progress, fabricate results, or impose artificial delay. Provide retry/error states.
5. Display the **actual number** of known breaches for that address free of charge, the coverage caveat, and basic security guidance. Don't expose sensitive breach details for addresses that have not been verified.
6. Offer clear options: unlock breach details and ongoing monitoring, start a free trial (if configured), restore purchases, or continue with free access. An existing user should be able to log in independently of payment.
7. Premium users see breach source, breach date, data categories, risk classification and plain-English remediation recommendations where genuinely provided/supported by the source.
8. Users may add verified email addresses up to their plan quota; every address must be independently verified (including family members, with their consent).
9. Schedule monitoring and send APNs pushes when **newly observed findings** appear. Push content should be discreet: “New security finding — open the app to review.” Do not reveal sensitive account or breach information on the lock screen.
10. Users can mark findings `new`, `reviewed`, or `action_taken`; never falsely imply the historical breach record itself has been erased.
11. Settings: manage addresses, notification preferences, subscription, privacy policy, support, sign out, delete account and associated stored data.

### In scope for v1

- Native SwiftUI iOS app, modern supported iOS deployment target chosen and documented.
- Cloudflare Workers TypeScript backend with typed HTTP routes and request/response validation.
- Cloudflare D1 for user accounts, verified monitored addresses, normalised breach findings, monitoring runs, entitlements snapshot, device tokens and audit events.
- Cloudflare Queues + Cron Triggers for scheduled checking and fan-out; idempotent processing and rate-limit-aware XON client.
- Cloudflare Email Service outbound transactional mail for email verification. If unavailable in the target account/region or still unsuitable for production, isolate an interface and provide a documented fallback provider; do not pretend Cloudflare Email Routing is outbound delivery.
- xonAPI+ adapter. Credentials and queries are **server-side only**.
- RevenueCat iOS SDK + StoreKit 2 for subscriptions, trials, restore purchases, entitlement display, and RevenueCat server-to-server webhooks (verified or authenticated according to current docs).
- Native APNs registration and a server-side push delivery component. APNs authentication credentials remain server-side and rotated securely.
- Privacy policy / terms placeholders (clearly marked as requiring legal review), App Store subscription disclosure, and consent screens.
- Simple observability: structured, non-PII logs, health status, job metrics and error classification.

### Out of scope for v1

- Password manager, password collection, actual stolen credential display or searching arbitrary third-party email addresses.
- VPN, device scanning, data broker removal, credit monitoring, bank connectivity.
- Automated background AI chatbot, autonomous actions or claims of guaranteed security.
- Android, browser extensions, enterprise dashboard, referral/affiliate programme.
- Hexproof and Squizz integration (see future architecture section).
- Stripe checkout **inside the Australian iOS app**. Apple in-app purchases via RevenueCat are primary. Stripe may be added later to a separately compliant web offering; keep entitlements provider-neutral, while enforcing current Apple storefront rules.

## 2. Subscription catalogue and configuration

All figures are **proposed AUD retail prices**, not verified demand or automatic App Store configurations. Implement remote/config-driven offerings and quotas; do not embed prices in security-sensitive backend logic.

| Tier | Initial proposal | Verified email quota | Features |
| --- | --- | ---: | --- |
| Free | $0 | 1 | Verified one-off breach count, security guidance, manual re-scan subject to abuse limits; no paid breach breakdown or continuous monitoring |
| Personal | $4.99/week | 3 | Full details, scheduled monitoring, push notifications, remediation tracking |
| Family | $7.99/week | 15 | Same functionality, multiple consented addresses, independent verification |

- Support testing **$14.99/month** as an alternate Personal offering and optional **7-day introductory free trial**. Assign experiments through RevenueCat offerings/experiments or suitable remote configuration. Don't simultaneously misrepresent renewal terms.
- Reserve possible 1/5/25-address products for future experiments, not launch-time tier proliferation.
- RevenueCat entitlement identifiers: `monitoring_personal`, `monitoring_family` (or one `monitoring` entitlement plus server-side resolved quota). Document the chosen mapping explicitly.
- Backend determines premium access by a current RevenueCat-confirmed entitlement, not only a client boolean. RevenueCat webhook updates should be idempotent, and a server-side reconciliation path should handle missed/delayed webhooks and grace periods.
- Enforce address count server-side and consistently across downgrades, expired subscriptions, refunds and trial expiries. For example, after downgrade, preserve addresses but pause monitoring above quota and clearly tell the user which remain active.
- Present localised App Store price and billing period sourced from StoreKit/RevenueCat, not hard-coded AUD labels in a global production build.
- Provide restore purchases, cancellation/manage subscription directions, privacy and terms links, trial end and renewal disclosure, and account deletion.

## 3. Preferred architecture

```text
SwiftUI iOS application
  ├── Email login / verified identity UI
  ├── Breach scan + gated results
  ├── RevenueCat Purchases / paywall
  └── APNs device registration
           |
           v
Cloudflare Worker API (TypeScript + Hono or equivalent)
  ├── Auth/session, verification, abuse controls
  ├── Subscription entitlement and quota service
  ├── MonitoredEmail and BreachFinding services
  ├── XonProvider (replaceable intelligence interface)
  ├── Cloudflare Email Service sender
  ├── D1 data and migrations
  └── Queue producer / monitoring jobs
           |
           +--> xonAPI+ paid provider (secret on server)
           +--> RevenueCat entitlement API + webhooks
           +--> Cloudflare Queue consumers + scheduled Cron
           +--> APNs delivery worker using provider tokens
```

Recommended repository layout:

```text
/
├── AGENTS.md
├── README.md
├── LICENSE                     # only if chosen by owner; don't assume open-source permission
├── .gitignore
├── .github/workflows/
│   ├── api-ci.yml
│   └── ios-ci.yml              # runner constraints documented
├── apps/ios/
│   ├── Exposure.xcodeproj/     # or reproducible XcodeGen/Tuist configuration
│   ├── Exposure/
│   │   ├── App/
│   │   ├── Features/Onboarding/
│   │   ├── Features/Verification/
│   │   ├── Features/Breaches/
│   │   ├── Features/Monitoring/
│   │   ├── Features/Subscription/
│   │   ├── Features/Settings/
│   │   ├── Core/API/
│   │   ├── Core/Auth/
│   │   ├── Core/Billing/
│   │   └── Core/Notifications/
│   └── ExposureTests/
├── apps/api/
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/
│   │   ├── services/
│   │   ├── providers/xon/
│   │   ├── providers/email/
│   │   ├── providers/push/
│   │   ├── jobs/
│   │   ├── db/
│   │   └── lib/
│   ├── migrations/
│   ├── test/
│   ├── wrangler.jsonc
│   └── package.json
├── packages/contracts/        # API schemas / OpenAPI; generate Swift models if practical
├── docs/
│   ├── ARCHITECTURE.md
│   ├── THREAT_MODEL.md
│   ├── API.md
│   ├── OPERATIONS.md
│   ├── BILLING.md
│   ├── PRIVACY.md
│   └── ROADMAP.md
└── .dev.vars.example
```

Use a single repository with a strict separation between mobile and backend. Avoid putting private provider credentials, RevenueCat server keys or business rules in the iOS app.

## 4. API contracts

Start with a small versioned REST API. Define OpenAPI and validation schemas.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/v1/auth/start` | Start email verification; generic response to avoid enumeration |
| POST | `/v1/auth/verify` | Verify code and issue or refresh a device-bound session |
| POST | `/v1/auth/refresh` | Rotate session credentials |
| POST | `/v1/auth/logout` | Revoke current session |
| GET | `/v1/me` | Identity, tier, quota, subscription state |
| GET | `/v1/addresses` | User's verified monitored emails |
| POST | `/v1/addresses/verify/start` | Start confirmation of another address |
| POST | `/v1/addresses/verify/complete` | Complete address verification |
| DELETE | `/v1/addresses/:id` | Stop monitoring and remove stored address data |
| POST | `/v1/addresses/:id/scan` | Trigger verified manual scan (quota and rate limit apply) |
| GET | `/v1/addresses/:id/summary` | Count and scan timestamp, including free accounts |
| GET | `/v1/addresses/:id/findings` | Premium-gated full details |
| PATCH | `/v1/findings/:id` | Mark reviewed/action taken |
| POST | `/v1/devices` | Register or update APNs device token and preferences |
| DELETE | `/v1/devices/:id` | Remove device token |
| POST | `/v1/billing/revenuecat/webhook` | Authenticated idempotent RevenueCat events |
| GET | `/v1/health` | Minimal non-sensitive health status |
| DELETE | `/v1/me` | Account deletion workflow including token revocation |

Use opaque, unpredictable IDs; ownership checks on every account-scoped resource. Use consistent error envelopes, request IDs, appropriate caching headers, and never publicly expose upstream payloads or internal stack traces.

## 5. XposedOrNot / xonAPI+ integration

Use documented paid API, not unofficial web scraping:

- Product: https://plus.xposedornot.com/products/api
- Docs linked from vendor page: https://console.xposedornot.com/
- Published illustrative endpoint: `GET https://plus-api.xposedornot.com/v3/check-email/{email}?detailed=true`
- Published header: `x-api-key: <secret>`

**Before implementation**, verify endpoint path, response schema, current rate limits, permissible caching, error statuses and webhook availability against live official documentation. The vendor's marketing sample is **not** sufficient to assume a complete type schema.

Create a provider-agnostic interface:

```ts
interface BreachIntelligenceProvider {
  checkVerifiedEmail(email: string): Promise<NormalisedBreachScan>;
}

type NormalisedBreachScan = {
  checkedAt: string;
  provider: 'xon';
  knownBreachCount: number;
  findings: Array<{
    externalId: string;
    sourceName: string;
    breachDate?: string;
    discoveredDate?: string;
    exposedDataClasses: string[];
    riskLevel?: 'low' | 'medium' | 'high' | 'unknown';
    remediationHints?: string[];
  }>;
};
```

- Parse defensively and distinguish `no breaches`, `provider unavailable`, `bad response`, `rate limited`, and `not authorised`.
- Do **not** treat API failures as zero breaches or reset prior findings following failed scans.
- Store the minimal fields needed for the user-facing product; avoid storing raw stolen credentials, leaked personal data, or full upstream payloads. Use safe deterministic finding keys to avoid duplicate notifications.
- Encode and protect email identifiers. Never include full email addresses in URL-based logging, analytics, crash reporting or error messages; the upstream API's documented URL path may carry an email, so ensure the HTTP client and edge telemetry redact paths.
- Queue scans; use adaptive backoff, deduplication and concurrency controls within purchased rate limits. Monitor per-provider latency, success/error rates and last successful scan timestamps.
- Make future alternative-provider adapters possible; **do not** implement HIBP integration in the MVP.

## 6. Data model and security

Design D1 schema and migrations for at least:

- `users` (id, primary_verified_email encrypted or protected, created_at, updated_at, deletion_state)
- `email_verifications` (id, email identifier, hashed one-time token, expiry, attempt counter, consumed_at)
- `sessions` (id, user_id, hashed refresh-token family, expiry, revoked_at)
- `monitored_emails` (id, user_id, encrypted email, blind-index/HMAC lookup value, verified_at, monitoring_enabled, last_successful_scan_at)
- `breach_findings` (id, monitored_email_id, provider, external_breach_id, normalised minimal metadata, first_seen_at, last_seen_at, user_status)
- `monitoring_jobs` (id, monitored_email_id, scheduled_at, started_at, completed_at, outcome, retry_count)
- `subscription_states` (user_id, revenuecat_app_user_id, plan, entitlement_expiration, last_verified_at)
- `processed_billing_events` (id, processed_at, outcome)
- `devices` (id, user_id, encrypted APNs token, platform, enabled, last_seen_at)
- `audit_events` (minimal security events, with fixed retention)

Security requirements:

1. No breach lookups or details for unverified third-party identities. Verification codes: short TTL, one-time use, hashed at rest, retry throttling; prevent enumeration and mass scanning.
2. Use HTTPS, Keychain-secured tokens, rotating refresh sessions, and device revocation. Don't store sensitive data in UserDefaults.
3. Encrypt monitored email values and APNs tokens at application level when practical. Store encryption keys in Cloudflare secrets, with rotation strategy. Use an HMAC blind index for lookups. Treat D1 access as sensitive.
4. Authorise every resource using server-side user identity; never trust a request-provided user ID. Separate free summary from premium details at the API layer.
5. Protect RevenueCat webhooks using the official supported authentication mechanism, replay/idempotency handling and server-side customer mapping. Reconcile periodically rather than trusting webhooks alone.
6. Data minimisation and privacy notices: explain the third-party transfer to XON, what a breach match means, retention, deletion and monitoring frequency. Provide account deletion both inside the app and operationally in the backend.
7. Explicit consent for adding family members' addresses; do not allow undisclosed bulk monitoring of other people's emails.
8. Apply coarse IP/device/account rate limiting without collecting excessive behavioural data. Use Cloudflare Turnstile only where supported and appropriate for the native flow; don't force a fragile web CAPTCHA if device/rate controls suffice.
9. Sanitise logs, analytics, crash reports and notification payloads. Never print email addresses, OTPs, tokens or vendor API payloads in production logs.
10. Security-test authorization boundaries, subscription expiry/downgrade races, queue retries, and deletion race conditions.

## 7. Monitoring and notifications

- Define configurable check cadence: start with **once daily per paid verified address**. This is a product target, not a promise of real-time detection from upstream.
- Cron selects eligible due addresses, Queue processes individual scan jobs, consumer persists findings transactionally, and notification job sends only for **newly observed** breach IDs.
- On initial scan, classify existing findings as historical; do not send a flood of notifications for them.
- Record `first_seen_at` relative to *our* scans separately from the upstream breach occurrence date.
- On repeated scans, dedupe by `(monitored_email_id, provider, external_breach_id)`; don't push repeatedly for a known finding.
- Respect notification consent, APNs failure responses and revocation. Provide a daily or immediate alert mode later, but avoid notifications for no-change events.
- Periodic digests are **future work** unless trivially implemented; don't generate misleading alerts to drive engagement.

## 8. UI / design direction

Visual style: confident, minimal, consumer-friendly, not a fake antivirus interface. SwiftUI with accessible dynamic type, VoiceOver labels, clear status colours, light/dark support, loading placeholders and good offline/error handling.

Required views:

- Welcome / value proposition
- Email entry
- Verification code entry
- Scan progress (real state-driven, without fake countdown)
- Free breach count / result
- Subscription paywall with StoreKit-localised terms, trial disclosures and restore
- Premium breach timeline / detail
- Address management (verify, remove, remaining quota)
- Notification settings
- Account settings, billing, support, privacy and deletion

No dark patterns: do not artificially delay scans, exaggerate risk, imply false precision, fabricate urgency or lock basic account deletion behind subscription. Explain that a historical breach may still appear after the password has been changed.

## 9. AI use (optional, not a dependency)

The owner can use substantial inference through AWS or Cloudflare, but AI is **not required** for the MVP. If implemented, use server-side generation only for evidence-grounded, non-alarmist plain-English explanations and remediation steps. Keep deterministic baseline templates so the product works when inference is unavailable. Do not send raw PII or sensitive upstream payloads to AI services without a separate data-processing and privacy review. Never claim AI can confirm an account is currently compromised from a historical breach record alone.

## 10. Future integrations (architecture only; DO NOT BUILD now)

- **Hexproof:** owner's custom email alias/security service. Future feature: link aliases to real-user monitored identities, track which alias appears in a breach, optionally offer alias rotation or management. Design a future integration boundary; do not assume any existing API or user database shape.
- **Squizz:** owner's browser security extension. Future feature: correlate browser warnings and visited-domain safety signals with the user's breach remediation dashboard; require explicit opt-in and minimal telemetry. Do not assume an API or implement extension code.
- Add a future `integrations/` domain in roadmap or docs, not a collection of unused runtime dependencies.
- Avoid prematurely merging account systems, collecting browsing history or granting either integration blanket access to security findings.

## 11. Implementation milestones (in order)

### M0 — Repository + reproducible scaffolding

- Initialise monorepo, README, architecture docs, CI, dependency lockfiles, lint/format/test commands, secret examples, local D1 migrations, Cloudflare Wrangler config, iOS project/configuration.
- README must contain copy-and-paste development setup for macOS/Xcode and Cloudflare tooling, and a clear list of third-party accounts required.

### M1 — Functioning scan vertical slice

- Build Cloudflare API with verification, secure session management, XON adapter, D1 persistence and scan result handling.
- Build SwiftUI onboarding and scan/result states wired to a local/staging backend.
- Ensure fake fixture mode is explicitly marked and inaccessible in production.
- Add tests for email ownership, parser failures, empty results and API rate limits.

### M2 — Subscription flow and enforcement

- Integrate RevenueCat iOS SDK with StoreKit test configurations and mocked sandbox data as needed.
- RevenueCat webhook ingestion, idempotency, entitlement reconciliation, backend-enforced findings access and address quotas.
- Test expired, refunded, trial, failed-payment, downgrade and restore scenarios.

### M3 — Continuous monitoring and notifications

- Cron + Queue scheduling; implement initial scan baseline, deduplication, retries, notifications and secure APNs credentials.
- Integration tests for repeated scans, upstream errors, disabled monitoring, revoked devices and quota changes.

### M4 — Release readiness

- App Store privacy disclosures, in-app deletion, restore purchases, failure UX, legal placeholders, crash/report redaction, security review, TestFlight checklist, operational/runbook docs.
- Prepare a small testing dataset and admin-free support workflows; no unnecessary back-office UI.

## 12. Definition of done

A new developer with valid credentials can:

1. Set up local API + database and launch the iOS app simulator.
2. Complete email verification and see a **real provider result** when configured, or clearly labelled mock results in local dev.
3. View a free breach count without premium access.
4. Use a StoreKit/RevenueCat sandbox subscription to unlock real detail endpoints.
5. Verify a second monitored address and see the quota enforced server-side.
6. Run a monitoring job twice and verify exactly one new-finding notification event.
7. Cancel/expire a subscription and observe secure downgrade with no data leak.
8. Remove an address, delete the account, and confirm deletion jobs revoke sessions and prevent later monitoring.
9. Run tests, static analysis and CI successfully, with documented exception for any signing/provider-dependent steps.

## 13. Repository documentation required

In README and docs, include:

- Architecture diagram and trust boundaries; Mermaid acceptable.
- All commands to run locally, migrate D1, deploy Workers, configure Queues/Cron and build iOS.
- Environment/bindings matrix for development, staging and production.
- RevenueCat App Store Connect integration and webhook configuration.
- Cloudflare Email Service setup (sender domain, SPF/DKIM, verified sending).
- XON provider key and rate-limit setup, plus provider data-usage/licensing assumption.
- APNs keys/team ID/bundle ID and environment handling.
- Privacy and breach-alert limitations, security threat model, and account deletion process.
- What remains manual before App Store release.

## 14. External references to verify against official current docs

- XON paid API: https://plus.xposedornot.com/products/api
- XON API docs: https://console.xposedornot.com/
- Cloudflare Email Service: https://developers.cloudflare.com/email-service/
- Cloudflare Workers / D1 / Queues / Cron: https://developers.cloudflare.com/
- RevenueCat iOS: https://www.revenuecat.com/docs/
- RevenueCat Web and Stripe (future, storefront restrictions apply): https://www.revenuecat.com/docs/web/payment-integrations
- Apple StoreKit and App Review: https://developer.apple.com/documentation/storekit and https://developer.apple.com/app-store/review/guidelines/

**Final instruction to agent:** Start implementing M0 and M1 immediately, then proceed to M2–M4 as far as the available environment and credentials permit. Do not stop at a proposal. Document external account setup blockers and never claim integrations are working without tests or live verification.
