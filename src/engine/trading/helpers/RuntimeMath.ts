import { roundMetric } from "../book/SortedBookSide";

export function returns(values: number[]): number[] {
  const output: number[] = [];

  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] - values[index - 1]);
  }

  return output;
}

export function pearson(left: number[], right: number[]): number | null {
  const count = Math.min(left.length, right.length);

  if (count < 2) {
    return null;
  }

  const x = left.slice(-count);
  const y = right.slice(-count);
  const meanX = x.reduce((sum, value) => sum + value, 0) / count;
  const meanY = y.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let index = 0; index < count; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    numerator += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 0 ? roundMetric(numerator / denominator, 8) : null;
}

// JSON.parse cannot validate a caller's desired shape; callers narrow the typed result.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function safeParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
