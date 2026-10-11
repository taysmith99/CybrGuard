# Roadmap

This repository preparation addresses M0 of [the product specification](../AGENTS.md). A health-check starter is not the specification's end-to-end MVP.

| Milestone | Intended result | Current state |
| --- | --- | --- |
| M0 — foundation | Reproducible API and iOS scaffolding, contracts, local migrations, dependency lockfile, CI and guides | Foundation supplied; follow local setup and Xcode prerequisites |
| M1 — verified scan | Email ownership, secure sessions, consent, real XON adapter, D1 persistence and scan UI; clearly labelled local fixtures | Not implemented |
| M2 — subscriptions | StoreKit/RevenueCat flow, authenticated billing events, reconciliation and server-enforced entitlements/quotas | Not implemented |
| M3 — monitoring | Cron and Queue jobs, deduplication, retries and discreet APNs notifications | Not implemented |
| M4 — release | Account deletion, operational procedures, privacy/terms, App Store disclosures, accessibility and security review | Not implemented |

For M1, implement the smallest verified-email scan end to end before expanding the interface. Use provider documentation to define the adapter and parser; test empty results separately from errors. Fictional fixtures must be visibly labelled and impossible to select in production. M0 contains neither a fixture breach dataset nor a live provider integration.

Before M2 or M3, verify ownership, authorisation, session handling and scan failure behaviour. Before release, exercise the full definition of done in `AGENTS.md`; successful scaffolding checks alone do not satisfy it.

Hexproof and Squizz remain future architectural integration boundaries. There are no assumptions about their APIs or account models, and no integration code. Android, browser extensions, password managers, VPNs, AI chat and data broker removal are outside this MVP.
