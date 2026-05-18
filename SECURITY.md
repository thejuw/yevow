# Security Policy

## Supported Branch

Security fixes are handled on `main` unless a private release branch is created
for a production incident.

## Reporting

Do not open public issues with secrets, wallet addresses tied to private
operations, API tokens, signing keys, production URLs, or exploit details.

Send security reports privately to the repository owner. Include:

- A concise description of the issue.
- Reproduction steps or affected endpoint.
- Impact assessment.
- Whether credentials, D1 data, KV config, JWTs, or exchange execution paths may
  be exposed.

## Operational Guardrails

- Never commit Cloudflare, Dwellir, Hyperliquid, Telegram, Discord, Axiom, or
  Honeycomb credentials.
- Rotate `JWT_SECRET`, `ADMIN_PASSWORD`, `HL_AGENT_SECRET`, and alerting tokens
  immediately after suspected exposure.
- Keep `SHADOW_MODE=true` and `EXCHANGE_ORDER_TEST_MODE=true` until live
  readiness checks and operator approval are complete.
- Use the `/admin/auth/revoke` endpoint to revoke JWT JTIs after operator
  turnover, suspicious activity, or shared-device use.
