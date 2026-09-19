# Evidence-first LOTTO upgrades

Approved scope, September 19, 2026: implement the model-review recommendations without promoting an untested picker or increasing the play budget.

## Implementation plan

1. Add strict official per-draw payout resolution for published non-jackpot pari-mutuel tiers. Preserve source URL, content hash, matching draw numbers and tier evidence in append-only settlements. Never automatically overwrite manual settlement or finalize a jackpot. Retry bounded failures and keep unresolved amounts visible.
2. Correct financial presentation: distinguish tracked commitment from graded spend, cash from free-ticket awards, pending payouts from zero returns, and paper proposals from confirmed purchases. Keep SMS idempotency and avoid re-announcing old wins on settlement.
3. Add versioned pure challenger generators: neutral selection, complement-invariant All or Nothing prize-aware portfolios, and bonus-diversity variants. Existing production picker and ticket SMS are unchanged.
4. Persist separate, immutable forward-only experiments before sales cutoff. Each variant includes its exact tickets, paired current and random controls, identical game/date/session/count/stake/style, seed, version, objective, configuration hash, data cutoff and dataset digest. Do not backfill historical experiments. Challenger records cannot become purchases or enter the live scoreboard.
5. Grade experiments against ingested official results, append revisions on result/payout changes, and show a separate private dashboard comparison. Predeclare December 20, 2026 as the first review date; no automatic promotion or forecast claims.
6. Prioritize missing expected draw sessions in background ingestion, with bounded polling and visible stale-result status.
7. Verify migration immutability, no-lookahead and race/idempotency boundaries, equal comparison exposure, grading consistency, authentication, UI parsing, and full regression suites. Deploy only the isolated LOTTO Worker and existing dashboard after checks pass; verify health and read-only production evidence afterward.

## Financial and research guardrails

- Money uses integer cents. Pending amounts produce incomplete/net-lower-bound displays, not invented losses or finalized ROI.
- Probability of any prize, probability of net profit, variance and expected dollars are distinct objectives. More frequent small prizes need not increase expected return.
- Challenger selection uses simulated fair draws only, never the target official result. Evaluation simulations use a separate seeded stream.
- Future comparisons remain paper-only at the same modeled cost; no extra Hermes pick messages, purchase transactions or budget changes.
- Exploration informed the challengers; future results are the holdout. A calendar review date is not proof of adequate power for rare jackpot effects.
- Schema additions are additive. Existing immutable tickets and grades remain intact; source and settlement corrections are new evidence.

## Implemented protocol

Protocol `forward-2026-09-v1` captures eligible, already-persisted system sets and their random
controls only before the actual ticket-sales cutoff. It rejects known results, missing provenance,
legacy attestations and unequal costs. Capture is repeat-safe and stops for draw dates on or after
December 20, 2026. Existing trials continue to be graded after that date; extending the experiment
or changing the live picker requires a reviewed, versioned decision.

The three arms are challenger, current optimizer and uniform random. All use identical ticket
counts, stakes, straight play and per-ticket options. In particular, the same ordinal modeled Mega
Millions multiplier is applied to all three arms, isolating number selection from multiplier luck.
These are paper awards, not proof of a bought ticket or paid claim. More frequent wins can coexist
with unchanged expected loss.

The All or Nothing challenger maximizes simulated probability of **any prize**, not expected
profit. Complementary 12-of-24 tickets have identical prize outcomes, so exposure treats a ticket
and its complement as the same. Selection and evaluation use independent reproducible simulation
streams. Simulation estimates are not evidence that drawings are predictable.

## Official payout-page authorization and limits

On September 19, 2026 the user explicitly authorized parsing official payout pages, a narrow
exception to the original CSV-only/no-scraping brief. Draw ingestion remains CSV-based. Payout
resolution follows only dated Texas Lottery detail-page links on the official winning-numbers
index, validates game, date, all winning numbers, table layout and prize tiers, and archives the
HTML evidence with its SHA-256 hash in R2 before appending a settlement.

Automatic settlement supports published Lotto Texas 4/6 and 5/6 prizes (base and Extra), and
Texas Two Step 4+0, 3+1, 3+0 and 2+1 prizes. Jackpots, capped top prizes and unsupported awards stay
pending for manual review. Existing manual or automatic settlements are never overwritten. A
later payout-only correction to an already-settled amount requires a new manual settlement with
fresh official evidence. Changed draw results are independently regraded using append-only events.

Downloads have bounded size, timeout, retries and per-draw backoff. Failed pages remain visible as
pending amounts; no amount is invented. Background work prioritizes least-recently-attempted
sources so unavailable prizes do not permanently block later draws. Delivery text may be refreshed
only if it has never been attempted or leased; settling a previously delivered win never resends it.

## Operations and release

- Migrations `0008_official_payouts.sql` and `0009_shadow_trials.sql` add acquisition state and
  append-only paper evidence. Required production schema: 9.
- Authenticated `GET /api/lotto/v1/ticket-lab/challengers` provides the dashboard's comparison;
  optional `game`, `from` and `to` filters never generate tickets or mutate evidence.
- Service-token-protected `GET /api/lotto/v1/service-status` adds `expectedResultGaps`, evaluated
  by exact game/date/session after a 20-minute publication grace. The existing ten-minute cron
  prioritizes one missing source before the ordinary half-hour archive rotation when generation
  is idle. A successful but unchanged download does not clear a missing-result condition.
- Payout acquisition status and retry errors are in `lotto_payout_sources`; structured maintenance
  logs identify payout, capture and grading failures. Unresolved prizes remain explicitly pending
  in the scoreboard. Fair leases and backoff apply to challenger grading.
- Deploy only the LOTTO Worker and dashboard. Do not deploy or reconfigure trading Workers, change
  selected games or budgets, rotate secrets, or send challenger tickets through Hermes.
- Before release: full Worker tests, strict dry run, dashboard browser tests/build, Python
  regressions, immutable-ledger and equal-exposure checks. Record a D1 recovery bookmark before
  applying migrations; prefer rolling back application code over deleting new evidence.
