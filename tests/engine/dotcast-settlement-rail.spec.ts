import { describe, expect, it } from "vitest";
import {
  confirmMockWithdrawal,
  creditDevnetDeposit,
  DotCastSettlementRailError,
  readSolanaUsdcSettlementRailStatus,
  reconcileDevnetSettlementRail,
  requestDevnetWithdrawal,
  type DotCastSettlementBalance,
  type DotCastSettlementRailEvent,
  type DotCastSettlementRailStore,
  type DotCastSettlementTransfer
} from "../../src/engine/dotcast";

describe("dotCast E5 Solana USDC devnet settlement rail", () => {
  it("reports a ready devnet mock rail without requiring private keys", () => {
    const status = readSolanaUsdcSettlementRailStatus(devnetEnv());

    expect(status).toMatchObject({
      mode: "devnet",
      cluster: "devnet",
      network: "solana-devnet",
      signerMode: "mock",
      decimals: 6,
      ready: true,
      operational: true,
      guards: []
    });
  });

  it("observes deposits, credits after confirmations, and never double-credits a txRef", async () => {
    const store = new InMemorySettlementRailStore();
    const env = devnetEnv();

    const observed = await creditDevnetDeposit(store, env, {
      userId: "user-rail",
      amount: 1_500_000,
      txRef: "devnet-deposit-sig-1",
      confirmations: 0,
      now: "2099-06-25T17:00:00.000Z"
    });
    const replayObserved = await creditDevnetDeposit(store, env, {
      userId: "user-rail",
      amount: 1_500_000,
      txRef: "devnet-deposit-sig-1",
      confirmations: 0,
      now: "2099-06-25T17:00:01.000Z"
    });
    const credited = await creditDevnetDeposit(store, env, {
      userId: "user-rail",
      amount: 1_500_000,
      txRef: "devnet-deposit-sig-1",
      confirmations: 1,
      now: "2099-06-25T17:00:02.000Z"
    });
    const replayCredited = await creditDevnetDeposit(store, env, {
      userId: "user-rail",
      amount: 1_500_000,
      txRef: "devnet-deposit-sig-1",
      confirmations: 1,
      now: "2099-06-25T17:00:03.000Z"
    });

    expect(observed).toMatchObject({
      status: "observed",
      idempotent: false,
      balance: { availableUsdc: 0, pendingDepositUsdc: 1_500_000 }
    });
    expect(replayObserved).toMatchObject({
      status: "observed",
      idempotent: true,
      balance: { availableUsdc: 0, pendingDepositUsdc: 1_500_000 }
    });
    expect(credited).toMatchObject({
      status: "credited",
      idempotent: false,
      balance: { availableUsdc: 1_500_000, pendingDepositUsdc: 0 }
    });
    expect(replayCredited).toMatchObject({
      status: "credited",
      idempotent: true,
      balance: { availableUsdc: 1_500_000, pendingDepositUsdc: 0 }
    });
    expect(store.events.map((event) => event.eventType)).toEqual([
      "DEPOSIT_OBSERVED",
      "DEPOSIT_CREDITED"
    ]);
  });

  it("mock-signs devnet withdrawals idempotently and confirms without broadcasting", async () => {
    const store = new InMemorySettlementRailStore();
    const env = devnetEnv();

    await creditDevnetDeposit(store, env, {
      userId: "user-withdraw",
      amount: 900_000,
      txRef: "devnet-deposit-sig-2",
      confirmations: 1,
      now: "2099-06-25T17:00:00.000Z"
    });

    const withdrawal = await requestDevnetWithdrawal(store, env, {
      userId: "user-withdraw",
      amount: 400_000,
      destination: "11111111111111111111111111111111",
      idempotencyKey: "idem-1",
      now: "2099-06-25T17:01:00.000Z"
    });
    const replay = await requestDevnetWithdrawal(store, env, {
      userId: "user-withdraw",
      amount: 400_000,
      destination: "11111111111111111111111111111111",
      idempotencyKey: "idem-1",
      now: "2099-06-25T17:01:01.000Z"
    });
    const confirmed = await confirmMockWithdrawal(store, env, {
      transferId: withdrawal.transfer.transferId,
      txRef: "mock-finalized-devnet-sig",
      now: "2099-06-25T17:02:00.000Z"
    });

    expect(withdrawal).toMatchObject({
      status: "signed",
      idempotent: false,
      broadcast: false,
      transfer: {
        status: "signed",
        signerMode: "mock",
        mockSignature: expect.stringMatching(/^mock-solana-devnet-/)
      },
      balance: { availableUsdc: 500_000, pendingWithdrawalUsdc: 400_000 }
    });
    expect(replay).toMatchObject({
      idempotent: true,
      balance: { availableUsdc: 500_000, pendingWithdrawalUsdc: 400_000 }
    });
    expect(confirmed).toMatchObject({
      status: "confirmed",
      transfer: { status: "confirmed", txRef: "mock-finalized-devnet-sig" },
      balance: { availableUsdc: 500_000, pendingWithdrawalUsdc: 0 }
    });
    expect(store.events.map((event) => event.eventType)).toContain("WITHDRAWAL_SIGNED");
    expect(store.events.map((event) => event.eventType)).toContain("WITHDRAWAL_CONFIRMED");
  });

  it("blocks mainnet withdrawals until an operator-approved live signer flow exists", async () => {
    const store = new InMemorySettlementRailStore();

    await expect(
      requestDevnetWithdrawal(store, mainnetEnv(), {
        userId: "user-mainnet",
        amount: 1,
        destination: "11111111111111111111111111111111",
        idempotencyKey: "blocked",
        now: "2099-06-25T17:00:00.000Z"
      })
    ).rejects.toMatchObject({
      name: "DotCastSettlementRailError",
      code: "MAINNET_WITHDRAWALS_BLOCKED",
      status: 403
    });
  });

  it("reconciles internal liabilities against a mocked custody balance", async () => {
    const store = new InMemorySettlementRailStore();
    const env = devnetEnv();

    await creditDevnetDeposit(store, env, {
      userId: "user-reconcile",
      amount: 1_000_000,
      txRef: "devnet-deposit-sig-3",
      confirmations: 1,
      now: "2099-06-25T17:00:00.000Z"
    });
    await requestDevnetWithdrawal(store, env, {
      userId: "user-reconcile",
      amount: 250_000,
      destination: "11111111111111111111111111111111",
      idempotencyKey: "reconcile-withdrawal",
      now: "2099-06-25T17:01:00.000Z"
    });

    const reconciliation = await reconcileDevnetSettlementRail(store, env, {
      custodiedAmount: 1_000_000,
      now: "2099-06-25T17:02:00.000Z"
    });

    expect(reconciliation).toMatchObject({
      availableUsdc: 750_000,
      pendingWithdrawalUsdc: 250_000,
      internalLiabilityUsdc: 1_000_000,
      driftUsdc: 0
    });
    expect(store.events.at(-1)).toMatchObject({
      eventType: "RECONCILIATION",
      reason: "BALANCED"
    });
  });
});

function devnetEnv() {
  return {
    DOTCAST_SETTLEMENT_RAIL_MODE: "devnet",
    DOTCAST_SOLANA_CLUSTER: "devnet",
    DOTCAST_SETTLEMENT_SIGNER_MODE: "mock",
    DOTCAST_DEPOSIT_CONFIRMATIONS_REQUIRED: "1",
    DOTCAST_WITHDRAWAL_MAX_MINOR_UNITS: "1000000"
  };
}

function mainnetEnv() {
  return {
    DOTCAST_SETTLEMENT_RAIL_MODE: "mainnet",
    DOTCAST_SOLANA_CLUSTER: "mainnet-beta",
    DOTCAST_SETTLEMENT_SIGNER_MODE: "external",
    DOTCAST_OPERATOR_WITHDRAWALS_APPROVED: "false"
  };
}

class InMemorySettlementRailStore implements DotCastSettlementRailStore {
  readonly balances = new Map<string, DotCastSettlementBalance>();
  readonly transfers = new Map<string, DotCastSettlementTransfer>();
  readonly events: DotCastSettlementRailEvent[] = [];

  async getBalance(userId: string): Promise<DotCastSettlementBalance | null> {
    return this.balances.get(userId) ?? null;
  }

  async saveBalance(balance: DotCastSettlementBalance): Promise<void> {
    this.balances.set(balance.userId, { ...balance });
  }

  async listBalances(): Promise<DotCastSettlementBalance[]> {
    return [...this.balances.values()].map((balance) => ({ ...balance }));
  }

  async getTransfer(transferId: string): Promise<DotCastSettlementTransfer | null> {
    return this.transfers.get(transferId) ?? null;
  }

  async getTransferByTxRef(txRef: string): Promise<DotCastSettlementTransfer | null> {
    return (
      [...this.transfers.values()].find(
        (transfer) => transfer.kind === "deposit" && transfer.txRef === txRef
      ) ?? null
    );
  }

  async insertTransfer(transfer: DotCastSettlementTransfer): Promise<void> {
    if (this.transfers.has(transfer.transferId)) {
      throw new DotCastSettlementRailError("DUPLICATE_TRANSFER", "transfer already exists", 409);
    }

    this.transfers.set(transfer.transferId, { ...transfer });
  }

  async updateTransfer(transfer: DotCastSettlementTransfer): Promise<void> {
    this.transfers.set(transfer.transferId, { ...transfer });
  }

  async appendEvent(event: DotCastSettlementRailEvent): Promise<void> {
    if (!this.events.some((candidate) => candidate.eventId === event.eventId)) {
      this.events.push({ ...event });
    }
  }
}
