# Phase 61 Hardening Status

This repository is not yet fully Phase 61 complete. The safe first pass implemented testable hardening pieces without changing cascade strategy behavior or safety defaults.

## Implemented In This Pass

- Added JWT revocation primitives in `src/auth/JwtRevocation.ts`.
- Added active-token tracking primitives for revoke-all workflows.
- Added fine-grained resource-action scope matching in `src/auth/ScopeMatcher.ts`.
- Integrated legacy scope compatibility into `AuthManager`.
- Added login attempt rate limiting, failed-login lockout, active-token tracking, revoked-token listing, and revoke-all admin routes in the gateway.
- Added reusable rate-limit primitives in `src/gateway/middleware/RateLimitMiddleware.ts`.
- Added initial trading-engine decomposition scaffolding:
  - `EngineStateStore`
  - `SharedTickGate`
  - `MarketMakingPipeline`
  - `CascadeRecoveryPipeline`
  - `PlacementResolver`
- Converted `src/TradingEngine.ts` into a one-line Durable Object export shell backed by
  `src/engine/trading/TradingEngineDO.ts`; the remaining legacy implementation now sits in
  `src/TradingEngineLegacy.ts` while it is decomposed in smaller passes.
- Moved colo/topology resolution and high-latency placement risk adjustment into
  `src/engine/trading/helpers/PlacementResolver.ts`.
- Moved sorted order-book side storage, price-keying, tick normalization, and crypto rounding into
  `src/engine/trading/book/SortedBookSide.ts`.
- Moved book rebuild/microstructure assembly into
  `src/engine/trading/book/BookReconstruction.ts`.
- Moved snapshot application, delta sequencing, crossed-book recovery, and top-of-book
  cross-checking into `src/engine/trading/book/OrderBookReconstructor.ts`.
- Moved book, replay, and cascade admin HTTP routing into
  `src/engine/trading/routes/*AdminRoutes.ts`, leaving the Durable Object to pass explicit
  state/action callbacks.
- Added Hyperliquid platform health filter logic.
- Added migration history documentation.
- Added operator runbook.
- Added focused tests across scope matching, revocation, rate limiting, state store abstraction,
  pipeline separation, placement resolution, sorted book-side behavior, book reconstruction,
  order-book reconstruction, extracted admin routes, and platform health filtering.

## Still Open

- Continue decomposing `TradingEngineLegacy.ts` into <800-line reviewable modules.
- Full `src/index.ts` gateway decomposition into the no-third-party router structure from the spec.
- Full `ExecutionerWorker.ts` and `IngestWorker.ts` decomposition.
- Promotion of full-tree lint from visible-only to enforced.
- Stop-order trigger roundtrip fixtures.
- TWAP slicing integration tests beyond the current unit coverage.
- Wiring platform health state into ingest-to-engine control flow and HYPE auto-flatten.
- Web component decomposition.
- Per-module 90% coverage hardening for `Backtester.ts`, `CascadeDetector.ts`, and `PositionManager.ts`.
- Final Phase 61 completion report and final commit message.

## Safety Defaults

- `STRATEGY_MODE` defaults were not changed.
- `TRADING_ENABLED` default behavior was not changed.
- No new `wrangler.toml` runtime variable changes were added.
- Cascade strategy behavior was not modified.
