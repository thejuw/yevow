import type { AuditSnapshot, CombinationSnapshot, FrequencySnapshot, GapSnapshot } from "./types";

const DISCLAIMER =
  "Not a prediction. These tests describe historical records against specified null models; they do not identify due numbers or improve draw odds.";

function frequencies(
  rows: readonly (readonly [number, number, number])[]
): readonly FrequencySnapshot[] {
  return Object.freeze(
    rows.map(([value, appearances, deviationPercent]) =>
      Object.freeze({ value, appearances, deviationPercent })
    )
  );
}

function gaps(rows: readonly (readonly [number, number, number])[]): readonly GapSnapshot[] {
  return Object.freeze(
    rows.map(([value, currentGap, meanCompletedGap]) =>
      Object.freeze({ value, currentGap, meanCompletedGap })
    )
  );
}

function combinations(
  rows: readonly (readonly [readonly number[], number])[]
): readonly CombinationSnapshot[] {
  return Object.freeze(rows.map(([values, count]) => Object.freeze({ values, count })));
}

const lottoFrequencies = frequencies([
  [31, 299, 12.69],
  [8, 297, 11.93],
  [26, 292, 10.05],
  [38, 291, 9.67],
  [15, 290, 9.3],
  [49, 290, 9.3],
  [19, 289, 8.92],
  [4, 286, 7.79],
  [17, 285, 7.41],
  [21, 285, 7.41],
  [27, 285, 7.41],
  [12, 280, 5.53],
  [44, 280, 5.53],
  [14, 279, 5.15],
  [35, 279, 5.15],
  [39, 273, 2.89],
  [52, 273, 2.89],
  [34, 272, 2.51],
  [10, 270, 1.76],
  [29, 269, 1.38],
  [54, 269, 1.38],
  [16, 268, 1.01],
  [24, 268, 1.01],
  [37, 268, 1.01],
  [5, 267, 0.63],
  [6, 267, 0.63],
  [7, 267, 0.63],
  [18, 266, 0.25],
  [25, 265, -0.13],
  [41, 265, -0.13],
  [42, 265, -0.13],
  [13, 264, -0.5],
  [43, 264, -0.5],
  [9, 262, -1.26],
  [22, 261, -1.63],
  [28, 259, -2.39],
  [36, 259, -2.39],
  [32, 256, -3.52],
  [51, 255, -3.89],
  [23, 254, -4.27],
  [40, 253, -4.65],
  [3, 252, -5.03],
  [20, 250, -5.78],
  [47, 249, -6.16],
  [1, 248, -6.53],
  [2, 247, -6.91],
  [53, 245, -7.66],
  [30, 241, -9.17],
  [33, 240, -9.55],
  [50, 239, -9.92],
  [11, 236, -11.06],
  [48, 236, -11.06],
  [46, 235, -11.43],
  [45, 224, -15.58]
]);

const lottoGaps = gaps([
  [1, 27, 8.53],
  [18, 25, 7.9],
  [24, 25, 7.84],
  [5, 24, 7.88],
  [10, 24, 7.78],
  [2, 20, 8.56],
  [17, 17, 7.34],
  [35, 15, 7.46],
  [21, 14, 7.31],
  [45, 14, 9.48],
  [52, 14, 7.72],
  [46, 13, 9.12],
  [27, 12, 7.27],
  [42, 12, 7.99],
  [28, 10, 8.21],
  [53, 10, 8.73],
  [31, 9, 6.98],
  [6, 8, 7.94],
  [9, 8, 8.08],
  [37, 8, 7.9],
  [15, 7, 7.16],
  [30, 7, 8.83],
  [44, 7, 7.53],
  [38, 6, 7.17],
  [29, 5, 7.83],
  [33, 5, 8.93],
  [43, 5, 8.0],
  [54, 5, 7.82],
  [3, 4, 8.4],
  [8, 4, 7.05],
  [50, 4, 9.0],
  [51, 4, 8.35],
  [11, 3, 9.12],
  [12, 3, 7.52],
  [26, 3, 7.14],
  [40, 3, 8.45],
  [48, 3, 9.11],
  [4, 2, 7.35],
  [22, 2, 8.14],
  [32, 2, 8.35],
  [36, 2, 8.21],
  [47, 2, 8.59],
  [13, 1, 8.03],
  [14, 1, 7.58],
  [16, 1, 7.92],
  [34, 1, 7.66],
  [41, 1, 8.01],
  [49, 1, 7.23],
  [7, 0, 7.97],
  [19, 0, 7.23],
  [20, 0, 8.56],
  [23, 0, 8.43],
  [25, 0, 8.03],
  [39, 0, 7.76]
]);

const cash5Frequencies = frequencies([
  [30, 381, 7.19],
  [10, 379, 6.63],
  [34, 377, 6.07],
  [23, 375, 5.51],
  [4, 372, 4.66],
  [7, 372, 4.66],
  [20, 372, 4.66],
  [24, 372, 4.66],
  [19, 371, 4.38],
  [9, 369, 3.82],
  [13, 367, 3.26],
  [18, 365, 2.69],
  [16, 364, 2.41],
  [6, 363, 2.13],
  [32, 360, 1.29],
  [35, 360, 1.29],
  [29, 359, 1.0],
  [3, 356, 0.16],
  [26, 352, -0.96],
  [8, 351, -1.25],
  [14, 350, -1.53],
  [5, 349, -1.81],
  [11, 349, -1.81],
  [31, 349, -1.81],
  [17, 348, -2.09],
  [25, 348, -2.09],
  [1, 347, -2.37],
  [22, 345, -2.93],
  [28, 339, -4.62],
  [12, 337, -5.18],
  [21, 337, -5.18],
  [15, 336, -5.47],
  [33, 330, -7.15],
  [2, 329, -7.44],
  [27, 310, -12.78]
]);

const cash5Gaps = gaps([
  [26, 29, 5.97],
  [4, 21, 5.62],
  [1, 20, 6.07],
  [23, 17, 5.6],
  [32, 16, 5.87],
  [7, 14, 5.57],
  [30, 10, 5.51],
  [35, 10, 5.9],
  [33, 8, 6.47],
  [8, 7, 6.09],
  [16, 7, 5.83],
  [18, 7, 5.81],
  [34, 7, 5.56],
  [12, 6, 6.35],
  [19, 6, 5.69],
  [21, 6, 6.37],
  [2, 5, 6.55],
  [3, 4, 5.97],
  [6, 4, 5.86],
  [20, 4, 5.69],
  [29, 4, 5.93],
  [24, 3, 5.69],
  [25, 3, 6.1],
  [10, 2, 5.56],
  [14, 2, 6.11],
  [17, 2, 6.14],
  [22, 2, 6.22],
  [27, 2, 7.04],
  [15, 1, 6.42],
  [31, 1, 6.13],
  [5, 0, 6.14],
  [9, 0, 5.75],
  [11, 0, 6.14],
  [13, 0, 5.78],
  [28, 0, 6.28]
]);

export const AUDIT_SNAPSHOTS = {
  lotto: {
    game: "lotto",
    generatedAt: "2026-09-04T02:14:49+00:00",
    eraStart: "2006-04-26",
    drawsAnalyzed: 2_388,
    observedFrom: "2006-04-26",
    observedThrough: "2026-09-02",
    source: {
      url: "https://www.texaslottery.com/export/sites/lottery/Games/Lotto_Texas/Winning_Numbers/lottotexas.csv",
      sha256: "379cc0c6889a400928631cec87ee6303855441796831ae9503594e5d03eac494",
      recordsRepresented: 2_388
    },
    familyWiseAlpha: 0.05,
    bonferroniThreshold: 0.025,
    findings: [
      {
        name: "Main-ball frequency uniformity",
        statistic: 68.705245,
        pValue: 0.072178358,
        verdict: "NO FLAG",
        detail: "Pearson goodness-of-fit across 54 values; finite-population corrected, df=53."
      },
      {
        name: "Draw-order position exchangeability",
        statistic: 275.02042,
        pValue: 0.402,
        verdict: "NO FLAG",
        detail: "Conditional Monte Carlo test with 999 within-draw shuffles."
      }
    ],
    frequencySampleSize: 14_328,
    frequencies: lottoFrequencies,
    gaps: lottoGaps,
    topPairs: combinations([
      [[14, 26], 44],
      [[8, 15], 42],
      [[15, 38], 42],
      [[27, 35], 41],
      [[4, 13], 40],
      [[8, 26], 40],
      [[7, 44], 39],
      [[8, 34], 39],
      [[19, 39], 39],
      [[21, 27], 39],
      [[14, 32], 38],
      [[14, 52], 38],
      [[19, 29], 38],
      [[34, 36], 38],
      [[4, 34], 37]
    ]),
    topTriplets: combinations([
      [[3, 29, 52], 9],
      [[5, 8, 32], 9],
      [[10, 34, 36], 9],
      [[14, 19, 32], 9],
      [[22, 25, 29], 9],
      [[1, 14, 32], 8],
      [[1, 32, 37], 8],
      [[1, 35, 42], 8],
      [[2, 7, 23], 8],
      [[2, 19, 43], 8],
      [[3, 4, 23], 8],
      [[5, 32, 37], 8],
      [[7, 27, 35], 8],
      [[8, 15, 39], 8],
      [[8, 19, 29], 8]
    ]),
    notes: [
      "No compatible record fell outside the configured historical weekday cadence.",
      "Winning-number exports expose draw positions but not machine or ball-set identifiers.",
      "A non-significant test does not prove randomness.",
      "Hot/cold, gaps, pairs, and triplets are descriptive only."
    ],
    disclaimer: DISCLAIMER
  },
  cash5: {
    game: "cash5",
    generatedAt: "2026-09-04T05:37:04+00:00",
    eraStart: "2018-09-24",
    drawsAnalyzed: 2_488,
    observedFrom: "2018-09-24",
    observedThrough: "2026-09-03",
    source: {
      url: "https://www.texaslottery.com/export/sites/lottery/Games/Cash_Five/Winning_Numbers/cashfive.csv",
      sha256: "600b797b71e3a9493358b549aa51e5aaaa7e7c6141b871d2b596a766403727d0",
      recordsRepresented: 2_488
    },
    familyWiseAlpha: 0.05,
    bonferroniThreshold: 0.025,
    findings: [
      {
        name: "Main-ball frequency uniformity",
        statistic: 29.350054,
        pValue: 0.69495711,
        verdict: "NO FLAG",
        detail: "Pearson goodness-of-fit across 35 values; finite-population corrected, df=34."
      },
      {
        name: "Draw-order position exchangeability",
        statistic: 152.39568,
        pValue: 0.218,
        verdict: "NO FLAG",
        detail: "Conditional Monte Carlo test with 999 within-draw shuffles."
      }
    ],
    frequencySampleSize: 12_440,
    frequencies: cash5Frequencies,
    gaps: cash5Gaps,
    topPairs: combinations([
      [[24, 30], 61],
      [[10, 32], 58],
      [[12, 13], 58],
      [[12, 19], 57],
      [[13, 30], 57],
      [[3, 9], 56],
      [[7, 29], 56],
      [[2, 28], 55],
      [[23, 25], 55],
      [[4, 6], 54],
      [[4, 35], 54],
      [[5, 23], 54],
      [[8, 16], 54],
      [[9, 11], 54],
      [[26, 30], 54],
    ]),
    topTriplets: combinations([
      [[10, 11, 13], 13],
      [[1, 12, 13], 12],
      [[1, 19, 25], 12],
      [[20, 21, 29], 12],
      [[3, 9, 11], 11],
      [[4, 13, 30], 11],
      [[7, 23, 25], 11],
      [[8, 30, 34], 11],
      [[10, 30, 32], 11],
      [[12, 13, 32], 11],
      [[13, 30, 32], 11],
      [[16, 21, 30], 11],
      [[17, 28, 34], 11],
      [[20, 23, 30], 11],
      [[1, 4, 20], 10]
    ]),
    notes: [
      "No compatible record fell outside the configured historical weekday cadence.",
      "Winning-number exports expose draw positions but not machine or ball-set identifiers.",
      "A non-significant test does not prove randomness.",
      "The current 5/35 matrix replaced 5/37 in September 2018.",
      "Hot/cold, gaps, pairs, and triplets are descriptive only."
    ],
    disclaimer: DISCLAIMER
  }
} as const satisfies Record<"lotto" | "cash5", AuditSnapshot>;
