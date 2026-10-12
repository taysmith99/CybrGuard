# Next options

Implement subscriptions last. Keep the UI plain; every feature must retain ownership checks, premium gates, privacy protections and real provider results.

- [x] **Remediation dashboard** — counts for outstanding/actioned findings, password-risk and status filters, loading/error/empty states. Verify counts and filtering against real findings in the simulator and unit tests.
- [x] **Better remediation guidance** — deterministic action checklists based on exposed data, persistent per-action progress, clear self-reported status. Verify guidance rules, ownership, persistence across rescans and deletion.
- [x] **Additional verified emails** — independent consent and six-digit email confirmation, server-enforced plan quotas, address selection/removal, downgrade behaviour. Verify cross-account and quota/verification races, plus simulator flow.
- [x] **Account security polish** — active sessions, revoke other devices/sessions, clearer consent and deletion feedback, working support link. Verify revocation and account ownership boundaries.
- [x] **New-breach monitoring** — opt-in scheduled paid-address checks using Cron/Queues, historical baseline, newly observed finding flags, retry/backoff and deduplication, visible last/next checks. Verify repeated jobs, provider failures, deletion/disable races and deployed scheduled configuration. Push delivery can follow later and must not be implied active.
- [x] **Subscription groundwork (last)** — subscription screens, localised StoreKit/RevenueCat offerings, restore/manage, authenticated idempotent webhooks, entitlement reconciliation and downgrade quotas. Verify local StoreKit/configuration and offline webhook lifecycle tests; document Apple/RevenueCat account-dependent setup and sandbox tests while enrollment is pending.

## Evidence and remaining external setup

Record completed checks here as work lands. Do not mark unchecked external integrations live. Apple Developer enrollment verification is pending; physical-device and App Store sandbox purchase validation may need to wait.

### Dashboard and guidance verification

- 82 API tests and 22 Swift tests pass; signed simulator build passes.
- Simulator with four real findings: 4 need attention, 0 remediated, 2 password risks, 18 suggested actions. Status/password-risk filters and empty-filter feedback verified.
- Checklist completion and undo verified against the local backend; temporary test action was undone. Persistence across rescans, expiry gating and account-deletion cascade covered by API tests.

### Additional addresses and account security verification

- API lint/typecheck and 92 offline tests pass, including independent ownership, purpose/account/device boundaries, OTP expiry/guess limits, single use, concurrent quota completions, downgrade pause/removal, foreign-account conflicts and pending-challenge deletion.
- SQLite migration preservation test retains existing emails, findings, remediation marks and per-action progress; foreign-key checks and deletion cascade pass. Local D1 migration applied successfully.
- Signed simulator build passes. Simulator shows primary email selection, 1 of 3 quota, independently consented add-email form and active current-session listing. A second real mailbox was not added; delivery/confirmation is covered with offline provider fixtures rather than bypassing ownership checks.
- Active-session tests cover listing, cross-account revocation denial, current-family retention and rejection of revoked access/refresh tokens. Support opens an email composer addressed to the configured security mailbox; delivery/replies are not asserted.
- Swift client tests cover authenticated additional verification and primary/secondary address decoding. These features were subsequently deployed with the monitoring milestone below.

### Scheduled monitoring verification

- API lint/typecheck and 97 tests pass. Cases cover historical baseline, newly observed IDs, repeated delivery/dispatch, eight-attempt failure exhaustion, preserved previous results, disabled/deleted addresses, expired entitlements, ownership and disabling during the upstream request.
- Local D1 migration 0007 applied. Simulator opt-in → real local Cron handler → actual local Cloudflare Queue consumer → real XON scan completed; UI showed last successful check and next check 24 hours later. Monitoring was disabled again after the test.
- Staging deployed version `4a42bbc9-5ef3-45eb-befe-5c6cb4f25cdb`, isolated `cybrguard-monitoring-staging` producer/consumer and `*/15 * * * *` Cron. HTTPS health verified after rollout. Queue messages carry only opaque job IDs. Staging monitoring remains opt-in; no push delivery is claimed.
- Dashboard new-finding badges use persisted `isNew`; existing findings remain historical, repeated sightings retain identity/remediation state, and marking a finding remediated clears its new flag.

### Subscription groundwork verification

- API lint/typecheck and 106 offline tests pass. Billing tests cover Personal/Family/free mapping, grace period, expiry/refund, malformed/failing provider results, 24-hour snapshot freshness, authenticated-account binding, concurrent reconciliation, downgrade quota enforcement without deleting addresses, both sides of transfers, webhook authentication/app/environment scope, duplicate/delayed events, retry after provider failure and deletion during lookup.
- Official RevenueCat SDK 5.94.0 is pinned; app-hosted simulator build and all 25 simulator tests pass. The StoreKit test loads all three local products with store prices, creates a verified `.xcode` transaction via Apple's test API, finishes it and confirms forced expiry in local transaction state. Cached StoreKit product status is not used as proof of expiry.
- Simulator subscription screen verified with the existing tester account: configuration notice, unavailable restore when unconfigured, privacy/terms navigation, manage-subscriptions link and renewal/account-deletion disclosures. No live purchase or Apple-account sign-in was performed. SDK purchase/restore paths compile but live RevenueCat sandbox transactions still require the external setup in `docs/BILLING.md`.
- Local migration 0008 applied; staging deployed version `ce41f932-9b60-412e-9b71-ec7657ddc768` with verified HTTPS health. Optional RevenueCat keys remain private and absent until account setup; free scans and administrative test access keep working. Real billing endpoints fail closed when unconfigured.
- `docs/BILLING.md` records exact Apple/RevenueCat product, entitlement, restore-policy, key, webhook and sandbox lifecycle steps. Apple enrollment, provider project/products and live sandbox validation remain explicit release gates; they are not represented as completed live integrations.

### RevenueCat Test Store integration follow-up

- Requested purchases-ios-spm package and RevenueCatUI linked at SDK 5.94.0. Debug-only Test Store configuration, `cybrguard_pro` customer information/stream, Paywall, Customer Center, restore and safe purchase error handling are implemented.
- RevenueCat project/app/entitlement identifiers retrieved through the provided v2 secret and saved only in local ignored files. Weekly/monthly/yearly products are all attached to Pro and the current default offering. The simulator loaded actual Test Store prices, exercised failure and success, and Customer Center displayed the active simulated subscription.
- Real Test Store weekly purchase activated `cybrguard_pro`; the local authenticated backend independently verified the active entitlement via v2 and wrote the three-address quota and confirmed expiry. No actual financial transaction or Apple-account sign-in occurred.
- Backend has 108 passing tests. Worker-compatible manual redirect handling verified through a real successful reconciliation. Staging version `bf3936dd-984b-41be-9f5c-27ffe6807114` deployed with private v2/webhook bindings and verified HTTPS health; live endpoint smoke checks returned 401 for invalid authorization and 200 for an authenticated sandbox TEST event and replay.
- A published dashboard Paywall is still missing from `default`; the RevenueCat SDK fallback was verified. Sandbox webhook registration was completed through RevenueCat API (`whintgr8664773206`); invalid-auth rejection and authenticated TEST/replay handling were verified. App-level Test Store restore and visible Paywall failure alerts were also verified. See docs/REVENUECAT_SWIFTUI.md for exact steps and code examples.
- On 12 October 2026, the staging-configured simulator completed independent email verification and a no-charge weekly Test Store purchase. SDK Pro became active; D1 changed from no billing snapshot to confirmed Personal with three addresses and the provider expiry. RevenueCat automatically delivered the matching `INITIAL_PURCHASE` event on its first attempt (HTTP 200, received true); its ID matched staging's processed-event table. Initial purchase callbacks also reconcile, and the administrative tester override remains enabled, so webhook-only renewal/downgrade enforcement and future Apple sandbox/TestFlight purchases remain separate checks.
