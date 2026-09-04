# RabbitHoleTX audit: Lotto Texas

> **Not a prediction.** This forensic report tests historical records against specified null models. It cannot identify numbers that are due or improve draw odds.

## Scope

- Generated (UTC): 2026-09-04T02:14:49+00:00
- Compatible 6/54 rules era: 2006-04-26 onward
- Draws analyzed: 2,388
- Observed range: 2006-04-26 through 2026-09-02
- Official export: <https://www.texaslottery.com/export/sites/lottery/Games/Lotto_Texas/Winning_Numbers/lottotexas.csv>
- Source SHA-256: `379cc0c6889a400928631cec87ee6303855441796831ae9503594e5d03eac494`

## Hypothesis tests

Family-wise alpha is 0.05. The Bonferroni-corrected decision threshold is 0.025.

| Test | Statistic | p-value | Verdict |
|---|---:|---:|---|
| Main-ball frequency uniformity | 68.705245 | 0.072178358 | NO FLAG |
| Draw-order position exchangeability | 275.020420 | 0.402000000 | NO FLAG |

Neither test crossed the corrected threshold. This audit therefore did not detect a departure from its null models. A non-significant result does **not** prove that the mechanism is random.

## Methods

- Frequency uniformity uses Pearson goodness-of-fit across 54 values, with 53 degrees of freedom and a finite-population correction for sampling without replacement.
- Position exchangeability uses 999 within-draw conditional Monte Carlo shuffles. Each shuffle preserves the six observed values while testing whether their recorded positions are exchangeable.
- The official export exposes draw positions, but not machine or ball-set identifiers; machine-specific bias cannot be tested from this file alone.
- Schedule validation found no compatible row outside the configured Monday/Wednesday/Saturday cadence.

## Descriptive observations

The largest positive frequency deviations were ball 31 (+12.69%), ball 8 (+11.93%), ball 26 (+10.05%), ball 38 (+9.67%), and balls 15 and 49 (+9.30%). The largest negative deviations were ball 45 (-15.58%), ball 46 (-11.43%), balls 11 and 48 (-11.06%), and ball 50 (-9.92%). These are retrospective descriptions, not selections.

The longest current gaps were ball 1 (27 draws), balls 18 and 24 (25), balls 5 and 10 (24), and ball 2 (20). Independent drawings have no memory; a long gap does not make a value due.

The most frequently observed pairs were 14-26 (44), 8-15 (42), 15-38 (42), and 27-35 (41). The leading triplets each appeared nine times: 3-29-52, 5-8-32, 10-34-36, 14-19-32, and 22-25-29. Historical co-occurrence does not increase future joint probability.

## Conclusion

The compatible Lotto Texas history produced **no statistical flag** in either configured family-wise-corrected test. This finding neither predicts future draws nor establishes that every unobserved aspect of the physical drawing process is unbiased.

---

Independent analysis by RabbitHoleTX for Yevow LOTTO. Not affiliated with or endorsed by the Texas Lottery Commission.
