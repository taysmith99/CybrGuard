# Development and operations

## Local foundation

Run the commands in the [README](../README.md#local-api-setup) from the repository root. The API uses local Wrangler execution and local D1 migration commands. Cloudflare documents how [local Workers execution and simulated bindings](https://developers.cloudflare.com/workers/local-development/) work.

Keep the dev server running while using the simulator. If the port is occupied, stop the existing process or change the API port and the iOS base URL together. A connection error is expected when the API is stopped. Do not interpret it as a breach result.

An HTTP 503 health response with `database_unavailable` can mean that the database has not been migrated. Run `npm run db:migrate:local` and try again. The `DB` binding points to the local `cybrguard-local` database. Its migration creates only a `schema_metadata` bootstrap table; it does not create product accounts or findings.

`APP_ENV` must be `development` or `test` to run this starter, and `DATA_MODE` must be `unconfigured`. Invalid values return `configuration_error`; `staging` and `production` return `scaffold_not_deployable`. These guards make incomplete product functionality explicit.

Use the repository's locked Wrangler version. The [D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/) explains local and remote migration options; the repository's development command selects local explicitly. Do not use `--remote` for routine local development.

The root package overrides Miniflare's `sharp` dependency to 0.35.5 to address [GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) while retaining the tested Wrangler version. Remove the override when a future age-eligible Wrangler update includes the fix, after checking the lockfile, dependency audit and local startup again.

## Environment matrix

| Concern | Development | Staging | Production |
| --- | --- | --- | --- |
| Worker | Local dev server | Not provisioned | Not provisioned |
| D1 | Local migration foundation | Separate database required | Separate database required |
| Health data mode | `unconfigured` | No integration configured | No integration configured |
| Secret storage | Ignored local variables | Cloudflare secrets required | Cloudflare secrets required |
| XON / email / billing / APNs | Not implemented | Adapters and sandbox verification required | Live integrations and review required |
| Queues / Cron | Not implemented | Dedicated bindings required | Dedicated bindings required |
| iOS | Simulator health check | HTTPS URL and signing required | Release configuration required |

An environment name in a schema is not a provisioned environment. Keep test, staging and production resources and credentials separate. Local examples must contain no real secrets. Additional credentials in an example file do not activate an integration.

## Deployment gate

`npm run build:api` is a packaging check, not a deployment. The starter is not ready to receive real accounts or personal information. The Worker configuration disables its `workers.dev` route and contains no public routes or deployment scripts; the runtime also rejects staging and production operation. No deployment, remote migration, queue creation, sender verification or App Store release has been performed by repository setup.

Before adding a deployment command:

1. Implement and test the relevant product milestone, including authorisation and failure behaviour.
2. Create explicit staging and production Wrangler environments with real resource bindings, and review the migration against a staging database.
3. Provision server secrets through Cloudflare secret management. Never put them in Wrangler configuration, the iOS target or CI output.
4. Add deployment and rollback instructions using the final environment names. Document backup/restore expectations, retention and incident contacts.
5. Validate the iOS release URL, signing, privacy disclosures and end-to-end staging flows.

## External setup to complete during implementation

| Integration | Manual work required |
| --- | --- |
| Cloudflare | Choose the account; provision separate D1 databases and later monitoring queues; configure Cron only after idempotent consumers exist. Store real binding IDs in reviewed environment configuration. |
| xonAPI+ | Obtain the paid key; confirm allowed consumer use, storage/caching terms, current schema and purchased request limits in the provider console; implement defensive parsing and rate-limit handling before making queries. |
| Email | Confirm outbound sending eligibility; verify a controlled sender domain and its required SPF/DKIM records; implement and test delivery, bounce and throttling handling. If unavailable, configure a documented fallback behind the email interface. |
| RevenueCat / Apple | Follow the billing guide; create products and sandbox testers, connect App Store Connect, configure entitlements, and register an authenticated webhook only after its handler exists. |
| APNs | Create a server-side signing key, record its key ID and Apple team ID, choose the final bundle ID, configure the app capability, and distinguish sandbox from production tokens. Test consent, revocation and delivery on supported devices. |

[Cloudflare Email Service](https://developers.cloudflare.com/email-service/) distinguishes outbound sending from incoming Email Routing; configuring routing alone is not a complete verification-mail system. Consult [Apple's token-based APNs guide](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns) when implementing push delivery.

Provider details are deliberately not implemented from marketing examples. The [xonAPI+ product page](https://plus.xposedornot.com/products/api) is a starting point for obtaining current documentation, not a complete response schema or licence grant.
