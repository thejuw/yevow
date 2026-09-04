# RabbitHoleTX Ticket Lab

## Purpose and truth boundary

Ticket Lab is a forward-testing and verification system, not a prediction engine. Every system,
random-baseline, or user-origin ticket is committed before its target drawing, then graded from the
official result. Losing tickets remain visible forever. Estimated or advertised prizes never count
as money won: fixed prizes are settled immediately, while pari-mutuel and conditionally
pari-mutuel awards remain pending until an append-only settlement event records the official value.

The dashboard and Hermes messages read the same ledger rows. Neither surface regenerates tickets.
Every user-facing result retains the standing warning: **picks are optimized, not predicted**.

## Production flow

```text
official ingest -> validated draw -> immutable grading -> result outbox -> Hermes
       |                                  |
       |                                  +-> append-only scorecard
       +-> pre-draw optimizer -> system + equal-size random ledger entries
                                           |
                                           +-> dashboard Ticket Lab tab
```

1. The draw-day generation transaction records the optimized set and an equal-sized deterministic
   random baseline before publishing the delivery payload.
2. Each ledger entry freezes the game and rule version, draw date/session, exact tickets and play
   options, protected seed, data cutoff and digest, coverage, split-risk output, ticket cost, and EV
   assumption at proposal time.
3. A purchase confirmation is a new event. It does not update the proposal. Where a physical ticket
   supplies new evidence—such as Mega Millions' printed multiplier—the confirmation event records
   the verified option without rewriting history.
4. A successful official ingest looks up every open ledger entry for that exact game, draw date,
   and session. Grading creates a new immutable revision derived from the official result
   fingerprint.
5. Fixed awards settle in cents. Jackpot and other unresolved pari-mutuel awards store their tier,
   match evidence, and `pending` status with a null cash value. A later operator settlement is a new
   event, never an edit.
6. The result outbox is independently idempotent. A repeated ingest may verify the grade again, but
   it cannot create a second logical grade or send the same result notification twice.

## Append-only guarantees

Cloudflare D1 is the production source of truth. Database constraints and mutation-blocking
triggers protect the ticket ledger, purchase events, grade revisions, ticket-grade details,
settlement events, result outbox, and delivery-attempt history. Application code exposes only
append operations.

Corrections cite the prior ledger entry with `correction_of` and receive a new identifier and
timestamp. They are accepted only before the applicable official result exists. The original entry
is preserved and remains queryable. The same rule applies to user-origin hand picks.

The scorecard separates:

- proposal face value from confirmed spend;
- system, equal-size random baseline, and user origins;
- settled cash from pending awards and non-cash prizes;
- graded tickets from open tickets;
- wins, losses, longest losing streak, best hit, and the complete prize-tier histogram.

Cash ROI and economic ROI are shown separately and exactly as calculated, including negative
values. Cash Five free Quick Picks contribute only to non-cash face value and economic ROI.
Pending awards do not silently become zero-dollar losses and estimates do not inflate returns.

## Rule versions and required ticket evidence

The grader freezes a rule version rather than applying today's rules retroactively. The initial
production version covers the current Texas formats:

- Lotto Texas 6/54, including whether EXTRA was purchased;
- Texas Two Step 4/35 plus one bonus ball from 1–35;
- Cash Five 5/35, including the 2-of-5 free Quick Pick as a non-cash prize;
- Powerball 5/69 plus 1/26, including Power Play purchase and the official draw multiplier;
- Mega Millions from April 8, 2025: 5/70 plus 1/24, with the multiplier printed on each play;
- Pick 3 and Daily 4 with draw session, stake, play style, Fireball, and Daily 4 pair position;
- All or Nothing 12/24, including both winning tails and the three losing middle counts.

Historical formats outside those effective-date gates must use their own versioned rule pack. The
grader fails closed when required evidence or official payout metadata is absent; it never guesses.

The server clock, interpreted in `America/Chicago`, closes live ledger writes at the official draw
break—not when a result happens to reach the export. A caller-supplied timestamp cannot reopen the
ledger. Current cutoffs are 22:02 for Lotto Texas, Texas Two Step, and Cash Five; 21:00 for
Powerball; 21:45 for Mega Millions; and 09:50, 12:17, 17:50, or 22:02 for the corresponding
Morning, Day, Evening, or Night Pick 3/Daily 4/All or Nothing session. A target must also fall on an
official draw weekday. These gates use the [Texas Lottery's published draw schedule](https://www.texaslottery.com/export/sites/lottery/Games/Pick_3/index.html).

Official references used to encode and fixture the rules:

- [Lotto Texas](https://www.texaslottery.com/export/sites/lottery/Documents/HTP_LottoTexas_ENG.pdf)
- [Texas Two Step](https://www.texaslottery.com/export/sites/lottery/Documents/HTP_TexasTwoStep_ENG.pdf)
- [Cash Five](https://www.texaslottery.com/export/sites/lottery/Documents/HTP_CashFive_ENG_SPAN.pdf)
- [Powerball](https://www.texaslottery.com/export/sites/lottery/Documents/HTP_Powerball_ENG.pdf)
- [Mega Millions](https://www.texaslottery.com/export/sites/lottery/Documents/HTP_MegaMillions_ENG.pdf)
- [Pick 3 and Fireball](https://www.texaslottery.com/export/sites/lottery/Documents/HTP_Pick3Fireball_ENG.pdf)
- [Daily 4 and Fireball](https://www.texaslottery.com/export/sites/lottery/Documents/HTP_Daily4_ENG.pdf)
- [All or Nothing](https://www.texaslottery.com/export/sites/lottery/Documents/HTP_AllorNothing_ENG.pdf)
- [Cash Five liability-cap rule, 16 TAC §401.308(d)](https://www.texaslottery.com/export/sites/lottery/Documents/legal/meetings/2018/comm_meeting_06212018_SectionVI.pdf)
- [All or Nothing liability-cap rule, 16 TAC §401.320(g)(1)(A)](https://www.texaslottery.com/export/sites/lottery/Documents/legal/rulemaking/Ch._401_rule_adoption_NOTEBOOK_FORMAT.pdf)

## Simulation modes

### Monte Carlo

Monte Carlo repeatedly creates legal tickets and independent legal drawings under the configured
game rules. It reports spend, return, ROI, tier counts, variance, jackpot frequency, losing
streaks, and a deterministic confidence trail from a caller-supplied seed. It exists because a
human lifetime contains too few jackpots to make lottery-scale risk intuitive. A large simulation
makes the ordinary outcome visible: occasional prizes do not overcome the ticket price, and the
average player loses slowly over repeated play.

The convergence test compares simulated return with the theoretical EV at the same prize
assumptions and uses a statistically justified tolerance. It is a test of the grader and sampler,
not evidence of predictive value.

### Historical backtest

For target draw `D`, the optimizer receives only validated drawings whose timestamp is strictly
earlier than `D`. The implementation records that cutoff and asserts it before generating a ticket.
Using `D` or any later draw—even indirectly through a cached statistic—is lookahead contamination
and aborts the run.

This restriction matters because a retrospective optimizer can appear skillful simply by learning
from the answer it is supposed to predict. A no-lookahead backtest measures only the process that
could actually have run at the time. Each system set is compared with an equal-size seeded random
baseline over the same target drawings and ticket costs. Expected long-run performance is
indistinguishable within sampling noise; split avoidance can affect a shared prize conditional on a
win, but it cannot make the balls more predictable.

### What-if budget replay

What-if mode converts a weekly budget into legal tickets on historical eligible draw dates, runs
the same no-lookahead system and baseline, and reports total spend, settled return, ROI, variance,
and streaks. A budget cap is enforced before generation. The report plainly states when the system
and random results are statistically indistinguishable.

## API and dashboard

Yevow-login-protected, read-only endpoints:

- `GET /api/lotto/v1/ticket-lab/summary`
- `GET /api/lotto/v1/ticket-lab/entries`

Both accept optional game and date filters; entries also accept status and cursor filters. The
Ticket Lab tab renders scorecards, origin comparisons, the complete tier histogram, and every
ticket with its result fingerprint, grade revision, payout status, and settlement evidence.

Bearer-protected append endpoints accept pre-draw user tickets, purchase confirmations, and final
pari-mutuel settlements. Settlement evidence must include an official Texas Lottery HTTPS URL and
its SHA-256; Cash Five and All or Nothing top-prize settlements also require the certified winning
play count. The service derives the liability-cap share itself, including the mandated whole-dollar
round-down, and rejects a mismatched amount. The service token is never sent to the browser.
Request bodies are bounded, game constraints are validated, and a result already present for the
target draw closes the ledger to new entries.

## Operations and recovery

Grading is part of official ingest. A malformed or incomplete result is quarantined by the existing
ingest controls and cannot grade tickets. A grading failure records operational evidence and queues
a Hermes alert instead of silently skipping the drawing. Result deliveries use the same leased,
append-only attempt model as generation messages and include priority claim guidance for a detected
jackpot.

D1 migrations are applied separately from Worker deployment. Before applying a production
migration, capture a D1 Time Travel bookmark. After release, verify schema version, integrity,
immutable-trigger behavior, open-ledger counts, result-outbox health, protected API authorization,
and dashboard/API consistency before considering the migration complete.

No secret, recipient, seed salt, session JWT, or Hermes credential is logged or returned by a
public endpoint.
