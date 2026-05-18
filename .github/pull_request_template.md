## Summary

- 

## Validation

- [ ] `npm run typecheck`
- [ ] `npm run web:typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm run test:engine`
- [ ] `npm run web:build`
- [ ] `npx wrangler deploy --dry-run`
- [ ] `npx wrangler deploy --config wrangler.ingest.toml --dry-run`
- [ ] `npx wrangler deploy --config wrangler.executioner.toml --dry-run`

## Trading Safety

- [ ] No secrets or API credentials are committed.
- [ ] `TRADING_ENABLED` remains fail-closed unless this PR is explicitly enabling live mode.
- [ ] `EXCHANGE_ORDER_TEST_MODE` remains true unless this PR is explicitly approved for live execution.
- [ ] Any risk-parameter change over 10 percent is called out in the summary.
