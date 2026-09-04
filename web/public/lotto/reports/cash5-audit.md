# RabbitHoleTX audit: Cash Five

> **Not a prediction.** This forensic report tests historical records against specified null models. It cannot identify numbers that are due or improve draw odds.

## Scope

- Generated (UTC): 2026-09-04T05:37:04+00:00
- Compatible 5/35 rules era: 2018-09-24 onward
- Draws analyzed: 2,488
- Observed range: 2018-09-24 through 2026-09-03
- Official export: <https://www.texaslottery.com/export/sites/lottery/Games/Cash_Five/Winning_Numbers/cashfive.csv>
- Source SHA-256: `600b797b71e3a9493358b549aa51e5aaaa7e7c6141b871d2b596a766403727d0`

## Hypothesis tests

Family-wise alpha is 0.05. The Bonferroni-corrected decision threshold is 0.025.

| Test | Statistic | p-value | Verdict |
|---|---:|---:|---|
| Main-ball frequency uniformity | 29.350054 | 0.694957110 | NO FLAG |
| Draw-order position exchangeability | 152.395680 | 0.218000000 | NO FLAG |

Neither test crossed the corrected threshold. This audit therefore did not detect a departure from its null models. A non-significant result does **not** prove that the mechanism is random.

## Methods

- Frequency uniformity uses Pearson goodness-of-fit across 35 values, with 34 degrees of freedom and a finite-population correction for sampling without replacement.
- Position exchangeability uses 999 within-draw conditional Monte Carlo shuffles. Each shuffle preserves the five observed values while testing whether their recorded positions are exchangeable.
- The official export exposes draw positions, but not machine or ball-set identifiers; machine-specific bias cannot be tested from this file alone.
- Schedule validation found no compatible row outside the configured Monday-through-Saturday cadence.
- The analysis excludes the earlier 5/37 era because combining incompatible matrices would invalidate the null model.

## Descriptive observations

The largest positive frequency deviations were ball 30 (+7.19%), ball 10 (+6.63%), ball 34 (+6.07%), ball 23 (+5.51%), and balls 4, 7, 20, and 24 (+4.66%). The largest negative deviations were ball 27 (-12.78%), ball 2 (-7.44%), ball 33 (-7.15%), ball 15 (-5.47%), and balls 12 and 21 (-5.18%). These are retrospective descriptions, not selections.

The longest current gaps were ball 26 (29 draws), ball 4 (21), ball 1 (20), ball 23 (17), and ball 32 (16). Independent drawings have no memory; a long gap does not make a value due.

The most frequently observed pairs were 24-30 (61), 10-32 (58), 12-13 (58), 12-19 (57), and 13-30 (57). The leading triplets were 10-11-13 (13) and 1-12-13, 1-19-25, and 20-21-29 (12 each). Historical co-occurrence does not increase future joint probability.

## Conclusion

The compatible Cash Five history produced **no statistical flag** in either configured family-wise-corrected test. This finding neither predicts future draws nor establishes that every unobserved aspect of the physical drawing process is unbiased.

---

Independent analysis by RabbitHoleTX for Yevow LOTTO. Not affiliated with or endorsed by the Texas Lottery Commission.
