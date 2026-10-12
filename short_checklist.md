# Next options

Implement subscriptions last. Keep the UI plain; every feature must retain ownership checks, premium gates, privacy protections and real provider results.

- [x] **Remediation dashboard** — counts for outstanding/actioned findings, password-risk and status filters, loading/error/empty states. Verify counts and filtering against real findings in the simulator and unit tests.
- [x] **Better remediation guidance** — deterministic action checklists based on exposed data, persistent per-action progress, clear self-reported status. Verify guidance rules, ownership, persistence across rescans and deletion.
- [x] **Additional verified emails** — independent consent and six-digit email confirmation, server-enforced plan quotas, address selection/removal, downgrade behaviour. Verify cross-account and quota/verification races, plus simulator flow.
- [x] **Account security polish** — active sessions, revoke other devices/sessions, clearer consent and deletion feedback, working support link. Verify revocation and account ownership boundaries.
- [x] **New-breach monitoring** — opt-in scheduled paid-address checks using Cron/Queues, historical baseline, newly observed finding flags, retry/backoff and deduplication, visible last/next checks. Verify repeated jobs, provider failures, deletion/disable races and deployed scheduled configuration. Push delivery can follow later and must not be implied active.
- [ ] **Subscription groundwork (last)** — subscription screens, localised StoreKit/RevenueCat offerings, restore/manage, authenticated idempotent webhooks, entitlement reconciliation and downgrade quotas. Verify local StoreKit/configuration and offline webhook lifecycle tests; document Apple/RevenueCat account-dependent setup and sandbox tests while enrollment is pending.

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
- Swift client tests cover authenticated additional verification and primary/secondary address decoding. Staging deployment of these new features remains pending.

### Scheduled monitoring verification

- API lint/typecheck and 97 tests pass. Cases cover historical baseline, newly observed IDs, repeated delivery/dispatch, eight-attempt failure exhaustion, preserved previous results, disabled/deleted addresses, expired entitlements, ownership and disabling during the upstream request.
- Local D1 migration 0007 applied. Simulator opt-in → real local Cron handler → actual local Cloudflare Queue consumer → real XON scan completed; UI showed last successful check and next check 24 hours later. Monitoring was disabled again after the test.
- Staging deployed version `4a42bbc9-5ef3-45eb-befe-5c6cb4f25cdb`, isolated `cybrguard-monitoring-staging` producer/consumer and `*/15 * * * *` Cron. HTTPS health verified after rollout. Queue messages carry only opaque job IDs. Staging monitoring remains opt-in; no push delivery is claimed.
- Dashboard new-finding badges use persisted `isNew`; existing findings remain historical, repeated sightings retain identity/remediation state, and marking a finding remediated clears its new flag.
