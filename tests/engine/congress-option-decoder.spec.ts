import { describe, expect, it } from "vitest";

import { decodeCongressOptionTrade } from "../../src/gateway/CongressOptionDecoder";

describe("Congress option trade decoder", () => {
  it("translates a readable call option into a bullish plain-English description", () => {
    const decoded = decodeCongressOptionTrade({
      symbol: "NVDA",
      assetName: "NVDA 12/20/24 $120C",
      rawText: "NVDA 12/20/24 $120C P $1,001 - $15,000",
      transactionType: "PURCHASE",
      transactionDate: "2024-01-10T00:00:00.000Z"
    });

    expect(decoded).toMatchObject({
      isOption: true,
      underlying: "NVDA",
      optionType: "CALL",
      strike: 120,
      expirationDate: "2024-12-20",
      exposure: "BULLISH"
    });
    expect(decoded?.plainEnglish).toContain("bullish");
    expect(decoded?.plainEnglish).toContain("above $120");
  });

  it("decodes OCC compact option symbols", () => {
    const decoded = decodeCongressOptionTrade({
      symbol: null,
      assetName: "AAPL 270115P00200000",
      rawText: "AAPL 270115P00200000 S $15,001 - $50,000",
      transactionType: "SALE",
      transactionDate: "2026-01-12T00:00:00.000Z"
    });

    expect(decoded).toMatchObject({
      underlying: "AAPL",
      optionType: "PUT",
      strike: 200,
      expirationDate: "2027-01-15",
      exposure: "BULLISH",
      isLeap: true
    });
  });

  it("does not mark ordinary stock purchase rows as option trades", () => {
    const decoded = decodeCongressOptionTrade({
      symbol: "AAPL",
      assetName: "SP Apple Inc. - Common Stock (AAPL)",
      rawText:
        "02/12/2026 | 03/10/2026 | P | $1,001 - $15,000 | SP Apple Inc. - Common Stock (AAPL)",
      transactionType: "PURCHASE",
      transactionDate: "2026-02-12T00:00:00.000Z"
    });

    expect(decoded).toBeNull();
  });

  it("does not confuse callable municipal debt with listed options", () => {
    const decoded = decodeCongressOptionTrade({
      symbol: null,
      assetName: "SP California St Go Call 12/1/27 4% due",
      rawText: "Partial sale of California State GO callable bond due 2035",
      transactionType: "SALE",
      transactionDate: "2026-06-01T00:00:00.000Z"
    });

    expect(decoded).toBeNull();
  });
});
