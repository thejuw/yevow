export const GAME_CODES = ["lotto", "twostep", "cash5", "pb", "mm", "p3", "d4", "aon"] as const;

export type GameCode = (typeof GAME_CODES)[number];
export type Session = "" | "morning" | "day" | "evening" | "night";

export interface ExportSource {
  readonly id: string;
  readonly game: GameCode;
  readonly name: string;
  readonly url: string;
  readonly session: Session;
  readonly expectedWidths: readonly number[];
}

export interface GameConfig {
  readonly code: GameCode;
  readonly name: string;
  readonly kind: "pool" | "bonus" | "digits";
  readonly main: {
    readonly count: number;
    readonly min: number;
    readonly max: number;
    readonly allowDuplicates: boolean;
  };
  readonly bonus?: {
    readonly count: number;
    readonly min: number;
    readonly max: number;
  };
  readonly baseCostCents: number;
  readonly auditStart: string;
  readonly schedule: string;
  readonly officialPage: string;
  readonly verifiedOn: string;
  readonly notes: readonly string[];
  readonly sources: readonly ExportSource[];
}

const OFFICIAL_ROOT = "https://www.texaslottery.com/export/sites/lottery/Games";

function source(
  game: GameCode,
  gameFolder: string,
  name: string,
  filename: string,
  expectedWidths: readonly number[],
  session: Session = ""
): ExportSource {
  return {
    id: `${game}:${name}`,
    game,
    name,
    url: `${OFFICIAL_ROOT}/${gameFolder}/Winning_Numbers/${filename}`,
    session,
    expectedWidths
  };
}

function sessionSources(
  game: GameCode,
  folder: string,
  stem: string,
  expectedWidths: readonly number[]
): readonly ExportSource[] {
  return (["morning", "day", "evening", "night"] as const).map((session) =>
    source(game, folder, `${stem}-${session}`, `${stem}${session}.csv`, expectedWidths, session)
  );
}

export const GAME_MANIFEST: Readonly<Record<GameCode, GameConfig>> = {
  lotto: {
    code: "lotto",
    name: "Lotto Texas",
    kind: "pool",
    main: { count: 6, min: 1, max: 54, allowDuplicates: false },
    baseCostCents: 100,
    auditStart: "2006-04-26",
    schedule: "Monday, Wednesday, Saturday",
    officialPage: `${OFFICIAL_ROOT}/Lotto_Texas/index.html`,
    verifiedOn: "2026-09-03",
    notes: ["EXTRA costs an additional $1 and does not enhance the jackpot."],
    sources: [source("lotto", "Lotto_Texas", "lottotexas", "lottotexas.csv", [10])]
  },
  twostep: {
    code: "twostep",
    name: "Texas Two Step",
    kind: "bonus",
    main: { count: 4, min: 1, max: 35, allowDuplicates: false },
    bonus: { count: 1, min: 1, max: 35 },
    baseCostCents: 100,
    auditStart: "2001-05-18",
    schedule: "Monday and Thursday",
    officialPage: `${OFFICIAL_ROOT}/Texas_Two_Step/index.html`,
    verifiedOn: "2026-09-03",
    notes: [],
    sources: [source("twostep", "Texas_Two_Step", "texastwostep", "texastwostep.csv", [9])]
  },
  cash5: {
    code: "cash5",
    name: "Cash Five",
    kind: "pool",
    main: { count: 5, min: 1, max: 35, allowDuplicates: false },
    baseCostCents: 100,
    auditStart: "2018-09-24",
    schedule: "Monday through Saturday",
    officialPage: `${OFFICIAL_ROOT}/Cash_Five/index.html`,
    verifiedOn: "2026-09-03",
    notes: ["The current 5/35 matrix replaced 5/37 in September 2018."],
    sources: [source("cash5", "Cash_Five", "cashfive", "cashfive.csv", [9])]
  },
  pb: {
    code: "pb",
    name: "Powerball",
    kind: "bonus",
    main: { count: 5, min: 1, max: 69, allowDuplicates: false },
    bonus: { count: 1, min: 1, max: 26 },
    baseCostCents: 200,
    auditStart: "2015-10-07",
    schedule: "Monday, Wednesday, Saturday",
    officialPage: `${OFFICIAL_ROOT}/Powerball/index.html`,
    verifiedOn: "2026-09-03",
    notes: ["Power Play costs an additional $1 and is outside base-play EV."],
    sources: [source("pb", "Powerball", "powerball", "powerball.csv", [10, 11])]
  },
  mm: {
    code: "mm",
    name: "Mega Millions",
    kind: "bonus",
    main: { count: 5, min: 1, max: 70, allowDuplicates: false },
    bonus: { count: 1, min: 1, max: 24 },
    baseCostCents: 500,
    auditStart: "2025-04-08",
    schedule: "Tuesday and Friday",
    officialPage: `${OFFICIAL_ROOT}/Mega_Millions/index.html`,
    verifiedOn: "2026-09-03",
    notes: ["The 1-24 Mega Ball matrix and built-in multiplier began April 8, 2025."],
    sources: [source("mm", "Mega_Millions", "megamillions", "megamillions.csv", [10, 11])]
  },
  p3: {
    code: "p3",
    name: "Pick 3",
    kind: "digits",
    main: { count: 3, min: 0, max: 9, allowDuplicates: true },
    baseCostCents: 50,
    auditStart: "1993-10-25",
    schedule: "Four draws Monday through Saturday",
    officialPage: `${OFFICIAL_ROOT}/Pick_3/index.html`,
    verifiedOn: "2026-09-03",
    notes: ["No digit is due; play style changes price, odds, and payout."],
    sources: sessionSources("p3", "Pick_3", "pick3", [7, 8, 9])
  },
  d4: {
    code: "d4",
    name: "Daily 4",
    kind: "digits",
    main: { count: 4, min: 0, max: 9, allowDuplicates: true },
    baseCostCents: 50,
    auditStart: "2007-10-01",
    schedule: "Four draws Monday through Saturday",
    officialPage: `${OFFICIAL_ROOT}/Daily_4/index.html`,
    verifiedOn: "2026-09-03",
    notes: ["No digit is due; play style changes price, odds, and payout."],
    sources: sessionSources("d4", "Daily_4", "daily4", [9, 10])
  },
  aon: {
    code: "aon",
    name: "All or Nothing",
    kind: "pool",
    main: { count: 12, min: 1, max: 24, allowDuplicates: false },
    baseCostCents: 200,
    auditStart: "2012-09-10",
    schedule: "Four draws Monday through Saturday",
    officialPage: `${OFFICIAL_ROOT}/All_or_Nothing/index.html`,
    verifiedOn: "2026-09-03",
    notes: ["Both 12 matches and 0 matches pay the top prize."],
    sources: sessionSources("aon", "All_or_Nothing", "allornothing", [16])
  }
};

export const SOURCES: readonly ExportSource[] = GAME_CODES.flatMap(
  (game) => GAME_MANIFEST[game].sources
);

export function isGameCode(value: string): value is GameCode {
  return (GAME_CODES as readonly string[]).includes(value);
}

export function getSource(sourceId: string): ExportSource {
  const found = SOURCES.find((candidate) => candidate.id === sourceId);
  if (!found) throw new RangeError(`Unknown source ${JSON.stringify(sourceId)}`);
  return found;
}

export function publicManifest(): readonly Omit<GameConfig, "sources">[] {
  return GAME_CODES.map((game) => {
    const { sources: ignored, ...config } = GAME_MANIFEST[game];
    void ignored;
    return config;
  });
}
