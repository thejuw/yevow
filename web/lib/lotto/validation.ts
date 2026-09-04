import { GAME_MANIFEST } from "./manifest";
import type { DigitPlayStyle, GameCode, GameManifestEntry, Ticket } from "./types";
import { LottoValidationError } from "./types";

const PERMUTATION_STYLES = new Set<DigitPlayStyle>([
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
]);

const PURE_PERMUTATION_STYLES = new Set<DigitPlayStyle>(["box", "anybox", "any-order", "combo"]);

export function isPermutationStyle(style: string): boolean {
  return PERMUTATION_STYLES.has(style.trim().toLowerCase() as DigitPlayStyle);
}

export function isPurePermutationStyle(style: string): boolean {
  return PURE_PERMUTATION_STYLES.has(style.trim().toLowerCase() as DigitPlayStyle);
}

function validatePool(
  values: readonly number[],
  rule: GameManifestEntry["main"],
  label: string
): void {
  if (!Array.isArray(values) || values.length !== rule.count) {
    throw new LottoValidationError(
      `${label} requires exactly ${rule.count} value(s); received ${Array.isArray(values) ? values.length : "a non-array"}`
    );
  }
  values.forEach((value, index) => {
    if (!Number.isSafeInteger(value)) {
      throw new LottoValidationError(
        `${label} value at position ${index + 1} must be a safe integer`
      );
    }
    if (value < rule.min || value > rule.max) {
      throw new LottoValidationError(
        `${label} value ${value} at position ${index + 1} is outside ${rule.min}-${rule.max}`
      );
    }
  });
  if (!rule.allowDuplicates && new Set(values).size !== values.length) {
    throw new LottoValidationError(`${label} values may not contain duplicates`);
  }
}

/** Validate and canonicalize a ticket against the selected game's current matrix. */
export function validateTicket(game: GameCode, ticket: Ticket): Ticket {
  if (!Object.prototype.hasOwnProperty.call(GAME_MANIFEST, game)) {
    throw new LottoValidationError(`Unknown lottery game ${JSON.stringify(game)}`);
  }
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
    throw new LottoValidationError("ticket must be a non-null object");
  }
  if (ticket.game !== game) {
    throw new LottoValidationError(
      `Ticket game ${ticket.game} does not match requested game ${game}`
    );
  }
  const config = GAME_MANIFEST[game];
  if (ticket.bonus !== undefined && !Array.isArray(ticket.bonus)) {
    throw new LottoValidationError("bonus selection must be an array");
  }
  const bonus = ticket.bonus ?? [];
  if (ticket.playStyle !== undefined && typeof ticket.playStyle !== "string") {
    throw new LottoValidationError("playStyle must be a string");
  }
  const style = (ticket.playStyle ?? "straight").trim().toLowerCase() as
    | DigitPlayStyle
    | "straight";

  validatePool(ticket.main, config.main, `${config.name} main selection`);
  if (config.bonus) {
    validatePool(bonus, config.bonus, `${config.name} bonus selection`);
  } else if (bonus.length !== 0) {
    throw new LottoValidationError(`${config.name} does not accept a bonus selection`);
  }

  if (config.kind === "digits") {
    if (!config.optimizerPlayStyles.includes(style as DigitPlayStyle)) {
      throw new LottoValidationError(
        `Unsupported ${config.name} optimizer play style ${JSON.stringify(style)}`
      );
    }
    if (isPermutationStyle(style) && new Set(ticket.main).size === 1) {
      throw new LottoValidationError(
        `${config.name} box/any-order play requires at least two distinct digits`
      );
    }
  } else if (style !== "straight") {
    throw new LottoValidationError(
      `${config.name} supports only the default straight ticket representation`
    );
  }

  return Object.freeze({
    game,
    main: Object.freeze(
      config.kind === "digits"
        ? [...ticket.main]
        : [...ticket.main].sort((left, right) => left - right)
    ),
    ...(bonus.length
      ? { bonus: Object.freeze([...bonus].sort((left, right) => left - right)) }
      : {}),
    playStyle: style
  });
}
