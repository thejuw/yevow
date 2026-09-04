import type { Seed } from "./types";

export type SeededRng = () => number;

/** xmur3 string hashing followed by sfc32; stable across JS engines. */
export function createSeededRng(seed: Seed): SeededRng {
  if (
    (typeof seed !== "string" && typeof seed !== "number") ||
    (typeof seed === "number" && !Number.isFinite(seed))
  ) {
    throw new TypeError("seed must be a string or finite number");
  }
  const text = `${typeof seed}:${String(seed)}`;
  let hash = 1_779_033_703 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3_432_918_353);
    hash = (hash << 13) | (hash >>> 19);
  }

  const nextSeed = (): number => {
    hash = Math.imul(hash ^ (hash >>> 16), 2_246_822_507);
    hash = Math.imul(hash ^ (hash >>> 13), 3_266_489_909);
    return (hash ^= hash >>> 16) >>> 0;
  };

  let a = nextSeed();
  let b = nextSeed();
  let c = nextSeed();
  let d = nextSeed();
  return (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const total = (a + b + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) + total;
    return (total >>> 0) / 4_294_967_296;
  };
}

export function randomInteger(rng: SeededRng, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
    throw new RangeError("randomInteger bounds must be safe integers");
  }
  if (maximum < minimum) {
    throw new RangeError("randomInteger maximum must be at least minimum");
  }
  return minimum + Math.floor(rng() * (maximum - minimum + 1));
}

export function sampleWithoutReplacement(
  rng: SeededRng,
  minimum: number,
  maximum: number,
  count: number
): number[] {
  const pool = Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
  if (!Number.isSafeInteger(count) || count < 0 || count > pool.length) {
    throw new RangeError("sample size is outside the source population");
  }
  for (let index = 0; index < count; index += 1) {
    const swapIndex = randomInteger(rng, index, pool.length - 1);
    [pool[index], pool[swapIndex]] = [pool[swapIndex]!, pool[index]!];
  }
  return pool.slice(0, count);
}

export function createUnseededSeed(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const words = new Uint32Array(4);
    cryptoApi.getRandomValues(words);
    return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
