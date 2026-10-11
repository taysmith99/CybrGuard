# API

## Implemented endpoint

`GET /v1/health` is public and returns a JSON service status. Local URL: `http://127.0.0.1:8788/v1/health`.

```json
{
  "status": "ok",
  "service": "cybrguard-api",
  "environment": "development",
  "dataMode": "unconfigured"
}
```

The contract restricts `environment` to `development`, `test`, `staging` or `production`. `dataMode` currently has only the value `unconfigured`. A successful status means the handler responded and the D1 bootstrap table was accessible; it is not evidence that an external service is operational.

An unmigrated database causes an HTTP 503 response. Apply local migrations before starting development. The foundation rejects staging and production operation with HTTP 503 (`scaffold_not_deployable`), and other routes in development/test return HTTP 404. Environment values in the contract do not imply a deployed staging or production service.

Responses include a generated `X-Request-ID`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Errors have this shape:

```json
{
  "error": {
    "code": "database_unavailable",
    "message": "Local database is not ready.",
    "requestId": "00000000-0000-4000-8000-000000000000"
  }
}
```

The request ID above is illustrative. Error codes currently cover `not_found`, `configuration_error`, `scaffold_not_deployable`, `database_unavailable` and `internal_error`.

The executable response schemas live in `packages/contracts`, alongside the [OpenAPI description](../packages/contracts/openapi.yaml). The iOS client decodes this response. When changing the contract, update the schema, OpenAPI, handler, client and relevant tests together.

## Future API

The route catalogue in [AGENTS.md](../AGENTS.md#4-api-contracts) is a design requirement, not a list of available endpoints. Auth, addresses, scans, findings, devices, billing and account deletion are not implemented.

Before adding account endpoints, define and test request validation, session revocation, ownership checks and abuse controls. Extend the existing error envelope, request IDs, cache policy and OpenAPI consistently. Never return provider payloads or internal error details directly to clients.
