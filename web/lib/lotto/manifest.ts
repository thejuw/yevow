import type { DigitPlayStyle, ExportSource, GameCode, GameManifestEntry } from "./types";

const OFFICIAL_ROOT = "https://www.texaslottery.com/export/sites/lottery/Games";

const optimizerDigitStyles = [
  "straight",
  "exact",
  "exact-order",
  "box",
  "anybox",
  "any-order",
  "straight-box",
  "straight/box",
  "straight+box",
  "exact-any",
  "exact/any",
  "exact-any-order",
  "exact/any-order",
  "exact/anybox",
  "combo"
] as const satisfies readonly DigitPlayStyle[];

const daily4EvStyles = [
  ...optimizerDigitStyles,
  "front-pair",
  "mid-pair",
  "middle-pair",
  "back-pair"
] as const satisfies readonly DigitPlayStyle[];

function source(
  folder: string,
  name: string,
  file: string,
  session?: ExportSource["session"]
): ExportSource {
  return {
    name,
    url: `${OFFICIAL_ROOT}/${folder}/Winning_Numbers/${file}`,
    ...(session ? { session } : {})
  };
}

function sessionSources(folder: string, stem: string): readonly ExportSource[] {
  return (["morning", "day", "evening", "night"] as const).map((session) =>
    source(folder, `${stem}-${session}`, `${stem}${session}.csv`, session)
  );
}

const straightOnly = ["straight"] as const;

/**
 * Current legal Texas draw-game matrices checked against the official game pages.
 * Historic exports can contain older matrices; `auditStart` marks the compatible era.
 */
export const GAME_MANIFEST: Readonly<Record<GameCode, GameManifestEntry>> = {
  lotto: {
    code: "lotto",
    name: "Lotto Texas",
    aliases: ["lotto-texas", "lt"],
    kind: "pool",
    main: { count: 6, min: 1, max: 54, allowDuplicates: false },
    baseCostCents: 100,
    outcomeCount: 25_827_165,
    topPrizeOdds: 25_827_165,
    auditStart: "2006-04-26",
    schedule: "Monday, Wednesday, Saturday",
    officialPage: `${OFFICIAL_ROOT}/Lotto_Texas/index.html`,
    exportSources: [source("Lotto_Texas", "lottotexas", "lottotexas.csv")],
    notes: ["EXTRA costs an additional $1 and does not enhance the jackpot."],
    verifiedOn: "2026-09-03",
    optimizerPlayStyles: straightOnly,
    evPlayStyles: straightOnly
  },
  twostep: {
    code: "twostep",
    name: "Texas Two Step",
    aliases: ["two-step", "texas-two-step", "tts"],
    kind: "bonus",
    main: { count: 4, min: 1, max: 35, allowDuplicates: false },
    bonus: { count: 1, min: 1, max: 35, allowDuplicates: false },
    baseCostCents: 100,
    outcomeCount: 1_832_600,
    topPrizeOdds: 1_832_600,
    auditStart: "2001-05-18",
    schedule: "Monday and Thursday",
    officialPage: `${OFFICIAL_ROOT}/Texas_Two_Step/index.html`,
    exportSources: [source("Texas_Two_Step", "texastwostep", "texastwostep.csv")],
    notes: [],
    verifiedOn: "2026-09-03",
    optimizerPlayStyles: straightOnly,
    evPlayStyles: straightOnly
  },
  cash5: {
    code: "cash5",
    name: "Cash Five",
    aliases: ["cash-five", "cf"],
    kind: "pool",
    main: { count: 5, min: 1, max: 35, allowDuplicates: false },
    baseCostCents: 100,
    outcomeCount: 324_632,
    topPrizeOdds: 324_632,
    auditStart: "2018-09-24",
    schedule: "Monday through Saturday",
    officialPage: `${OFFICIAL_ROOT}/Cash_Five/index.html`,
    exportSources: [source("Cash_Five", "cashfive", "cashfive.csv")],
    notes: ["The current 5/35 matrix replaced 5/37 in September 2018."],
    verifiedOn: "2026-09-03",
    optimizerPlayStyles: straightOnly,
    evPlayStyles: straightOnly
  },
  pb: {
    code: "pb",
    name: "Powerball",
    aliases: ["powerball"],
    kind: "bonus",
    main: { count: 5, min: 1, max: 69, allowDuplicates: false },
    bonus: { count: 1, min: 1, max: 26, allowDuplicates: false },
    baseCostCents: 200,
    outcomeCount: 292_201_338,
    topPrizeOdds: 292_201_338,
    auditStart: "2015-10-07",
    schedule: "Monday, Wednesday, Saturday",
    officialPage: `${OFFICIAL_ROOT}/Powerball/index.html`,
    exportSources: [source("Powerball", "powerball", "powerball.csv")],
    notes: ["Power Play costs an additional $1 and is outside base-play EV."],
    verifiedOn: "2026-09-03",
    optimizerPlayStyles: straightOnly,
    evPlayStyles: straightOnly
  },
  mm: {
    code: "mm",
    name: "Mega Millions",
    aliases: ["mega", "mega-millions"],
    kind: "bonus",
    main: { count: 5, min: 1, max: 70, allowDuplicates: false },
    bonus: { count: 1, min: 1, max: 24, allowDuplicates: false },
    baseCostCents: 500,
    outcomeCount: 290_472_336,
    topPrizeOdds: 290_472_336,
    auditStart: "2025-04-08",
    schedule: "Tuesday and Friday",
    officialPage: `${OFFICIAL_ROOT}/Mega_Millions/index.html`,
    exportSources: [source("Mega_Millions", "megamillions", "megamillions.csv")],
    notes: ["The 1-24 Mega Ball matrix and built-in multiplier began April 8, 2025."],
    verifiedOn: "2026-09-03",
    optimizerPlayStyles: straightOnly,
    evPlayStyles: straightOnly
  },
  p3: {
    code: "p3",
    name: "Pick 3",
    aliases: ["pick3", "pick-3"],
    kind: "digits",
    main: { count: 3, min: 0, max: 9, allowDuplicates: true },
    baseCostCents: 50,
    outcomeCount: 1_000,
    topPrizeOdds: 1_000,
    auditStart: "1993-10-25",
    schedule: "Four draws Monday through Saturday",
    officialPage: `${OFFICIAL_ROOT}/Pick_3/index.html`,
    exportSources: sessionSources("Pick_3", "pick3"),
    notes: [
      "Base wager may be $0.50, $1, $2, $3, $4, or $5; FIREBALL doubles the wager.",
      "No digit is due; straight and box choices change price, odds, and payout."
    ],
    verifiedOn: "2026-09-03",
    optimizerPlayStyles: optimizerDigitStyles,
    evPlayStyles: optimizerDigitStyles
  },
  d4: {
    code: "d4",
    name: "Daily 4",
    aliases: ["daily4", "daily-4"],
    kind: "digits",
    main: { count: 4, min: 0, max: 9, allowDuplicates: true },
    baseCostCents: 50,
    outcomeCount: 10_000,
    topPrizeOdds: 10_000,
    auditStart: "2007-10-01",
    schedule: "Four draws Monday through Saturday",
    officialPage: `${OFFICIAL_ROOT}/Daily_4/index.html`,
    exportSources: sessionSources("Daily_4", "daily4"),
    notes: [
      "Base wager may be $0.50, $1, $2, $3, $4, or $5; FIREBALL doubles the wager.",
      "No digit is due; play style changes price, odds, and payout."
    ],
    verifiedOn: "2026-09-03",
    optimizerPlayStyles: optimizerDigitStyles,
    evPlayStyles: daily4EvStyles
  },
  aon: {
    code: "aon",
    name: "All or Nothing",
    aliases: ["all-or-nothing", "allornothing"],
    kind: "pool",
    main: { count: 12, min: 1, max: 24, allowDuplicates: false },
    baseCostCents: 200,
    outcomeCount: 2_704_156,
    topPrizeOdds: 1_352_078,
    auditStart: "2012-09-10",
    schedule: "Four draws Monday through Saturday",
    officialPage: `${OFFICIAL_ROOT}/All_or_Nothing/index.html`,
    exportSources: sessionSources("All_or_Nothing", "allornothing"),
    notes: [
      "Both 12 matches and 0 matches pay the top prize; combined top-prize odds are 1 in 1,352,078."
    ],
    verifiedOn: "2026-09-03",
    optimizerPlayStyles: straightOnly,
    evPlayStyles: straightOnly
  }
};

export function isGameCode(value: string): value is GameCode {
  return Object.prototype.hasOwnProperty.call(GAME_MANIFEST, value);
}

export function getGameManifest(game: GameCode): GameManifestEntry {
  const config = (GAME_MANIFEST as Partial<Record<string, GameManifestEntry>>)[game];
  if (!config) throw new RangeError(`Unknown lottery game ${JSON.stringify(game)}`);
  return config;
}
