# CybrGuard XON API tests

The local smoke suite validates the provider connection independently of the M0 app. A successful test does not enable an app scan, verify user ownership, or implement subscriptions and monitoring.

## Run the live checks

Set `XON_API_KEY` in the ignored root `.env`, then run from the repository root:

```sh
npm run test:xon
```

The script reads `.env` directly without executing it. It sends the key only to the fixed HTTPS origin `plus-api.xposedornot.com`, refuses redirects, applies request timeouts, and accepts no custom email or destination arguments. It uses `test@example.com`, a generated address at the reserved `example.com` domain, and a malformed input. It never prints credentials, email values, breach names, raw responses, or upstream error messages.

The suite makes at most six sequential requests, spaced by at least 1.5 seconds, with no automatic retries. It stops on a rate limit, server failure or transport failure. It does not run in CI or as part of `npm run check`; provider requests may consume the account's allowance.

| Scenario | Expected result |
| --- | --- |
| Valid key, simple response | HTTP 200, success envelope, unique breach IDs |
| Valid key, detailed response | HTTP 200, supported metadata types, IDs consistent with the simple response |
| Generated reserved test address | HTTP 200 with an empty breach array |
| Malformed email | HTTP 404 error, not a zero-breach success |
| Missing key | HTTP 422 validation error |
| Deliberately invalid key | HTTP 401 authentication error |

`npm test` covers the harness with fictional responses, including nullable metadata, malformed payloads, authentication failures, rate limits, server errors, timeouts and safe output. Rate limiting and outages are simulated rather than induced against the live provider.

## Latest verification

On 11 October 2026, all six live scenarios passed using the configured key. `npm run check` also passed formatting, recommended lint rules, TypeScript checks and all 48 offline tests (10 API tests and 38 smoke-harness tests). No live response bodies or personal lookup results were saved in the repository.

## Contract references and limits

Checked on 11 October 2026:

- The [official OpenAPI endpoint](https://plus-api.xposedornot.com/openapi.json) declares `GET /v3/check-email/{email}`, the `detailed` query parameter, the `x-api-key` header, and the success/error status codes.
- The served OpenAPI document references response components that are absent from that document. It is not a complete machine-readable response schema.
- The [official quickstart](https://plus.xposedornot.com/blog/xonapi-quickstart) documents simple IDs, detailed metadata, empty successes and error envelopes. The test assertions combine that guide with observed responses, permit additional fields, and do not claim to validate every future provider variation.

Before implementing the production adapter, confirm the complete response schema, purchased limits, storage/caching terms and webhook availability in the provider console. Keep personal lookups outside the reusable fixture suite and saved reports. App-level ownership checks remain required before exposing account-specific results.
