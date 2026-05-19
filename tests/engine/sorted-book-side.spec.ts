import { describe, expect, it } from "vitest";
import {
  bucketPrice,
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  priceFromKey,
  priceKey,
  roundCrypto,
  roundMetric,
  SortedBookSide
} from "../../src/engine/trading/book/SortedBookSide";

const OBSERVED_AT = "2026-05-18T04:00:00.000Z";

describe("SortedBookSide", () => {
  it("normalizes crypto precision and tick prices", () => {
    expect(roundMetric(1.23456, 2)).toBe(1.23);
    expect(roundCrypto(1.123456789)).toBe(1.12345679);
    expect(priceFromKey(priceKey(123.45678901))).toBe(123.45678901);
    expect(() => priceKey(-1)).toThrow("INVALID_ORDER_BOOK_PRICE");
    expect(() => priceKey(Number.NaN)).toThrow("INVALID_ORDER_BOOK_PRICE");
    expect(normalizePriceToTick(100.24, 0.5, "FLOOR")).toBe(100);
    expect(normalizePriceToTick(100.24, 0.5, "CEIL")).toBe(100.5);
    expect(normalizePriceToTick(0, 0, "CEIL")).toBe(DEFAULT_ORDER_BOOK_TICK_SIZE);
    expect(bucketPrice(100.24, 0.5, "bid")).toBe(100);
    expect(bucketPrice(100.24, 0.5, "ask")).toBe(100.5);
    expect(bucketPrice(100.246, 0, "bid")).toBe(100.246);
  });

  it("keeps bid levels sorted high-to-low with price-bucket aggregation", () => {
    const bids = new SortedBookSide("bid");

    bids.upsert(100.1, 1, OBSERVED_AT, 0.5);
    bids.upsert(100.2, 2, OBSERVED_AT, 0.5);
    bids.upsert(99.9, 3, OBSERVED_AT, 0.5);

    expect(bids.size).toBe(2);
    expect(bids.top(5)).toEqual([
      { price: 100, size: 3, updatedAt: OBSERVED_AT },
      { price: 99.5, size: 3, updatedAt: OBSERVED_AT }
    ]);
    expect(bids.range(99.75, 100.25, 5)).toEqual([{ price: 100, size: 3, updatedAt: OBSERVED_AT }]);

    bids.upsert(100.1, 0, OBSERVED_AT, 0.5);
    expect(bids.top(1)).toEqual([{ price: 100, size: 2, updatedAt: OBSERVED_AT }]);
    bids.upsert(100.2, 0, OBSERVED_AT, 0.5);
    expect(bids.top(5)).toEqual([{ price: 99.5, size: 3, updatedAt: OBSERVED_AT }]);
  });

  it("keeps ask levels sorted low-to-high and supports clearing", () => {
    const asks = new SortedBookSide("ask");

    asks.upsert(100.7, 1, OBSERVED_AT, 0.5);
    asks.upsert(100.1, 2, OBSERVED_AT, 0.5);

    expect(asks.top(5)).toEqual([
      { price: 100.5, size: 2, updatedAt: OBSERVED_AT },
      { price: 101, size: 1, updatedAt: OBSERVED_AT }
    ]);
    expect(asks.range(100.75, 101.25, 5)).toEqual([
      { price: 101, size: 1, updatedAt: OBSERVED_AT }
    ]);

    asks.clear();
    expect(asks.size).toBe(0);
    expect(asks.top(5)).toEqual([]);
  });

  it("rejects invalid size and ignores deletion of absent raw levels", () => {
    const bids = new SortedBookSide("bid");

    expect(() => {
      bids.upsert(100, -1, OBSERVED_AT, 1);
    }).toThrow("INVALID_ORDER_BOOK_SIZE");
    bids.upsert(100, 0, OBSERVED_AT, 1);
    expect(bids.top(1)).toEqual([]);
  });
});
