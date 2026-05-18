export class EMA {
  private readonly multiplier: number;
  private current: number | null = null;
  private samples = 0;

  constructor(private readonly period: number) {
    if (!Number.isFinite(period) || period <= 0) {
      throw new Error("EMA_PERIOD_MUST_BE_POSITIVE");
    }
    this.multiplier = 2 / (period + 1);
  }

  update(value: number): number | null {
    if (!Number.isFinite(value)) {
      return this.current;
    }

    this.samples += 1;
    this.current =
      this.current === null
        ? value
        : value * this.multiplier + this.current * (1 - this.multiplier);

    return this.samples >= this.period ? this.current : null;
  }

  value(): number | null {
    return this.current;
  }
}

export function calculateEma(values: number[], period: number): number | null {
  const ema = new EMA(period);
  let latest: number | null = null;

  for (const value of values) {
    latest = ema.update(value);
  }

  return latest;
}
