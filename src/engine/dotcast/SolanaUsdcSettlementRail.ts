import type {
  DotCastSettlementBalance,
  DotCastSettlementRailEvent,
  DotCastSettlementRailStatus,
  DotCastSettlementSignerMode,
  DotCastSettlementTransfer,
  DotCastSettlementTransferStatus,
  DotCastSolanaCluster
} from "./types";

export const DOTCAST_USDC_DECIMALS = 6;
export const DOTCAST_SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DOTCAST_SOLANA_MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface DotCastSettlementRailEnv {
  DOTCAST_SETTLEMENT_RAIL_MODE?: string;
  DOTCAST_SOLANA_CLUSTER?: string;
  DOTCAST_SOLANA_USDC_MINT?: string;
  DOTCAST_SETTLEMENT_SIGNER_MODE?: string;
  DOTCAST_OPERATOR_WITHDRAWALS_APPROVED?: string;
  DOTCAST_WITHDRAWAL_MAX_MINOR_UNITS?: string;
  DOTCAST_DEPOSIT_CONFIRMATIONS_REQUIRED?: string;
}

export interface DotCastSettlementRailStore {
  getBalance(userId: string): Promise<DotCastSettlementBalance | null>;
  saveBalance(balance: DotCastSettlementBalance): Promise<void>;
  listBalances(): Promise<DotCastSettlementBalance[]>;
  getTransfer(transferId: string): Promise<DotCastSettlementTransfer | null>;
  getTransferByTxRef(txRef: string): Promise<DotCastSettlementTransfer | null>;
  insertTransfer(transfer: DotCastSettlementTransfer): Promise<void>;
  updateTransfer(transfer: DotCastSettlementTransfer): Promise<void>;
  appendEvent(event: DotCastSettlementRailEvent): Promise<void>;
}

export interface CreditDevnetDepositInput {
  userId: string;
  amount: number;
  txRef: string;
  confirmations: number;
  now?: string;
}

export interface RequestDevnetWithdrawalInput {
  userId: string;
  amount: number;
  destination: string;
  idempotencyKey: string;
  now?: string;
}

export interface ConfirmMockWithdrawalInput {
  transferId: string;
  txRef?: string;
  now?: string;
}

export interface ReconcileDevnetRailInput {
  custodiedAmount: number;
  now?: string;
}

export class DotCastSettlementRailError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "DotCastSettlementRailError";
    this.code = code;
    this.status = status;
  }
}

export class D1DotCastSettlementRailStore implements DotCastSettlementRailStore {
  constructor(private readonly db: D1Database) {}

  async getBalance(userId: string): Promise<DotCastSettlementBalance | null> {
    const row = await this.db
      .prepare(
        `SELECT user_id, available_usdc, pending_deposit_usdc, pending_withdrawal_usdc,
                locked_pool_usdc, locked_bond_usdc, updated_at
         FROM dotcast_settlement_balances
         WHERE user_id = ?`
      )
      .bind(userId)
      .first();

    return row ? balanceFromRow(row) : null;
  }

  async saveBalance(balance: DotCastSettlementBalance): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dotcast_settlement_balances (
           user_id, available_usdc, pending_deposit_usdc, pending_withdrawal_usdc,
           locked_pool_usdc, locked_bond_usdc, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           available_usdc = excluded.available_usdc,
           pending_deposit_usdc = excluded.pending_deposit_usdc,
           pending_withdrawal_usdc = excluded.pending_withdrawal_usdc,
           locked_pool_usdc = excluded.locked_pool_usdc,
           locked_bond_usdc = excluded.locked_bond_usdc,
           updated_at = excluded.updated_at`
      )
      .bind(
        balance.userId,
        balance.availableUsdc,
        balance.pendingDepositUsdc,
        balance.pendingWithdrawalUsdc,
        balance.lockedPoolUsdc,
        balance.lockedBondUsdc,
        balance.updatedAt
      )
      .run();
  }

  async listBalances(): Promise<DotCastSettlementBalance[]> {
    const result = await this.db
      .prepare(
        `SELECT user_id, available_usdc, pending_deposit_usdc, pending_withdrawal_usdc,
                locked_pool_usdc, locked_bond_usdc, updated_at
         FROM dotcast_settlement_balances`
      )
      .all();

    return (result.results ?? []).map(balanceFromRow);
  }

  async getTransfer(transferId: string): Promise<DotCastSettlementTransfer | null> {
    const row = await this.db
      .prepare(
        `SELECT transfer_id, user_id, kind, status, network, cluster, mint, amount, tx_ref,
                destination, signer_mode, mock_signature, requested_at, updated_at, event_json
         FROM dotcast_settlement_transfers
         WHERE transfer_id = ?`
      )
      .bind(transferId)
      .first();

    return row ? transferFromRow(row) : null;
  }

  async getTransferByTxRef(txRef: string): Promise<DotCastSettlementTransfer | null> {
    const row = await this.db
      .prepare(
        `SELECT transfer_id, user_id, kind, status, network, cluster, mint, amount, tx_ref,
                destination, signer_mode, mock_signature, requested_at, updated_at, event_json
         FROM dotcast_settlement_transfers
         WHERE tx_ref = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .bind(txRef)
      .first();

    return row ? transferFromRow(row) : null;
  }

  async insertTransfer(transfer: DotCastSettlementTransfer): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO dotcast_settlement_transfers (
           transfer_id, user_id, kind, status, network, cluster, mint, amount, tx_ref,
           destination, signer_mode, mock_signature, requested_at, updated_at, event_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...transferParams(transfer))
      .run();
  }

  async updateTransfer(transfer: DotCastSettlementTransfer): Promise<void> {
    await this.db
      .prepare(
        `UPDATE dotcast_settlement_transfers
         SET status = ?, tx_ref = ?, destination = ?, signer_mode = ?, mock_signature = ?,
             updated_at = ?, event_json = ?
         WHERE transfer_id = ?`
      )
      .bind(
        transfer.status,
        transfer.txRef,
        transfer.destination,
        transfer.signerMode,
        transfer.mockSignature,
        transfer.updatedAt,
        JSON.stringify(transfer.eventJson),
        transfer.transferId
      )
      .run();
  }

  async appendEvent(event: DotCastSettlementRailEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO dotcast_settlement_rail_events (
           event_id, user_id, event_type, network, cluster, mint, amount, tx_ref, withdrawal_id,
           status, reason, event_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.eventId,
        event.userId,
        event.eventType,
        event.network,
        event.cluster,
        event.mint,
        event.amount,
        event.txRef,
        event.withdrawalId,
        event.status,
        event.reason,
        JSON.stringify(event.eventJson),
        event.createdAt
      )
      .run();
  }
}

export function readSolanaUsdcSettlementRailStatus(
  env: DotCastSettlementRailEnv
): DotCastSettlementRailStatus {
  const mode = parseRailMode(env.DOTCAST_SETTLEMENT_RAIL_MODE);
  const cluster = parseCluster(env.DOTCAST_SOLANA_CLUSTER, mode);
  const signerMode = parseSignerMode(env.DOTCAST_SETTLEMENT_SIGNER_MODE, mode);
  const network = cluster === "devnet" ? "solana-devnet" : "solana-mainnet-beta";
  const mint =
    nullableText(env.DOTCAST_SOLANA_USDC_MINT?.trim()) ??
    (cluster === "devnet" ? DOTCAST_SOLANA_DEVNET_USDC_MINT : DOTCAST_SOLANA_MAINNET_USDC_MINT);
  const depositConfirmationsRequired = parsePositiveEnvInt(
    env.DOTCAST_DEPOSIT_CONFIRMATIONS_REQUIRED,
    1
  );
  const withdrawalMaxMinorUnits = parsePositiveEnvInt(
    env.DOTCAST_WITHDRAWAL_MAX_MINOR_UNITS,
    1_000_000
  );
  const operatorWithdrawalsApproved = env.DOTCAST_OPERATOR_WITHDRAWALS_APPROVED === "true";
  const guards: string[] = [];

  if (mode === "disabled") {
    guards.push("settlement rail disabled");
  }

  if (mode === "devnet" && cluster !== "devnet") {
    guards.push("devnet mode requires solana devnet cluster");
  }

  if (mode === "devnet" && signerMode !== "mock") {
    guards.push("devnet settlement rail requires mock signer mode");
  }

  if (mode === "mainnet") {
    guards.push("mainnet withdrawals require operator approval and live signer integration");
  }

  if (!mint) {
    guards.push("solana usdc mint is not configured");
  }

  const ready = mode === "devnet" && cluster === "devnet" && signerMode === "mock" && Boolean(mint);

  return {
    mode,
    network,
    cluster,
    mint,
    decimals: DOTCAST_USDC_DECIMALS,
    signerMode,
    depositConfirmationsRequired,
    withdrawalMaxMinorUnits,
    operatorWithdrawalsApproved,
    ready,
    operational: ready,
    guards
  };
}

export async function readSettlementBalance(
  store: DotCastSettlementRailStore,
  userId: string,
  now = new Date().toISOString()
): Promise<DotCastSettlementBalance> {
  return (await store.getBalance(userId)) ?? emptyBalance(userId, now);
}

export async function creditDevnetDeposit(
  store: DotCastSettlementRailStore,
  env: DotCastSettlementRailEnv,
  input: CreditDevnetDepositInput
): Promise<{
  status: "observed" | "credited";
  idempotent: boolean;
  transfer: DotCastSettlementTransfer;
  balance: DotCastSettlementBalance;
  rail: DotCastSettlementRailStatus;
}> {
  const rail = assertDevnetMockRail(env);
  const now = input.now ?? new Date().toISOString();
  const userId = requireText(input.userId, "userId");
  const txRef = requireText(input.txRef, "txRef");
  assertPositiveAmount(input.amount, "amount");
  assertNonNegativeInteger(input.confirmations, "confirmations");

  const existing = await store.getTransferByTxRef(txRef);
  if (existing) {
    if (
      existing.kind !== "deposit" ||
      existing.userId !== userId ||
      existing.amount !== input.amount
    ) {
      throw new DotCastSettlementRailError(
        "DEPOSIT_TX_REF_CONFLICT",
        "deposit txRef already belongs to a different transfer",
        409
      );
    }

    if (existing.status === "credited") {
      return {
        status: "credited",
        idempotent: true,
        transfer: existing,
        balance: await readSettlementBalance(store, userId, now),
        rail
      };
    }

    if (input.confirmations < rail.depositConfirmationsRequired) {
      return {
        status: "observed",
        idempotent: true,
        transfer: existing,
        balance: await readSettlementBalance(store, userId, now),
        rail
      };
    }

    const credited = {
      ...existing,
      status: "credited" as const,
      updatedAt: now,
      eventJson: {
        ...existing.eventJson,
        confirmations: input.confirmations,
        creditedAt: now
      }
    };
    const balance = await readSettlementBalance(store, userId, now);
    const nextBalance = {
      ...balance,
      availableUsdc: balance.availableUsdc + input.amount,
      pendingDepositUsdc: Math.max(0, balance.pendingDepositUsdc - input.amount),
      updatedAt: now
    };

    await store.updateTransfer(credited);
    await store.saveBalance(nextBalance);
    await store.appendEvent(transferEvent(credited, "DEPOSIT_CREDITED", "credited", now));

    return {
      status: "credited",
      idempotent: false,
      transfer: credited,
      balance: nextBalance,
      rail
    };
  }

  const transfer: DotCastSettlementTransfer = {
    transferId: `dotcast:e5:deposit:${txRef}`,
    userId,
    kind: "deposit",
    status:
      input.confirmations >= rail.depositConfirmationsRequired
        ? ("credited" as const)
        : ("observed" as const),
    network: rail.network,
    cluster: rail.cluster,
    mint: rail.mint,
    amount: input.amount,
    txRef,
    destination: null,
    signerMode: rail.signerMode,
    mockSignature: null,
    requestedAt: now,
    updatedAt: now,
    eventJson: {
      source: "solana-usdc-devnet",
      confirmations: input.confirmations,
      requiredConfirmations: rail.depositConfirmationsRequired
    }
  };
  const balance = await readSettlementBalance(store, userId, now);
  const nextBalance =
    transfer.status === "credited"
      ? {
          ...balance,
          availableUsdc: balance.availableUsdc + input.amount,
          updatedAt: now
        }
      : {
          ...balance,
          pendingDepositUsdc: balance.pendingDepositUsdc + input.amount,
          updatedAt: now
        };

  await store.insertTransfer(transfer);
  await store.saveBalance(nextBalance);
  await store.appendEvent(transferEvent(transfer, "DEPOSIT_OBSERVED", "observed", now));

  if (transfer.status === "credited") {
    await store.appendEvent(transferEvent(transfer, "DEPOSIT_CREDITED", "credited", now));
  }

  return {
    status: transfer.status === "credited" ? "credited" : "observed",
    idempotent: false,
    transfer,
    balance: nextBalance,
    rail
  };
}

export async function requestDevnetWithdrawal(
  store: DotCastSettlementRailStore,
  env: DotCastSettlementRailEnv,
  input: RequestDevnetWithdrawalInput
): Promise<{
  status: "signed";
  idempotent: boolean;
  broadcast: false;
  transfer: DotCastSettlementTransfer;
  balance: DotCastSettlementBalance;
  rail: DotCastSettlementRailStatus;
}> {
  const rail = assertDevnetMockRail(env);
  const now = input.now ?? new Date().toISOString();
  const userId = requireText(input.userId, "userId");
  const destination = requireText(input.destination, "destination");
  const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
  assertPositiveAmount(input.amount, "amount");

  if (!isLikelySolanaAddress(destination)) {
    throw new DotCastSettlementRailError(
      "INVALID_SOLANA_DESTINATION",
      "destination must look like a Solana address",
      400
    );
  }

  if (input.amount > rail.withdrawalMaxMinorUnits) {
    throw new DotCastSettlementRailError(
      "WITHDRAWAL_AMOUNT_EXCEEDS_DEVNET_LIMIT",
      "withdrawal amount exceeds the configured devnet limit",
      400
    );
  }

  const transferId = `dotcast:e5:withdrawal:${userId}:${idempotencyKey}`;
  const existing = await store.getTransfer(transferId);
  if (existing) {
    return {
      status: "signed",
      idempotent: true,
      broadcast: false,
      transfer: existing,
      balance: await readSettlementBalance(store, userId, now),
      rail
    };
  }

  const balance = await readSettlementBalance(store, userId, now);
  if (balance.availableUsdc < input.amount) {
    throw new DotCastSettlementRailError(
      "INSUFFICIENT_USDC_BALANCE",
      "available USDC balance is insufficient for this devnet withdrawal",
      409
    );
  }

  const transfer: DotCastSettlementTransfer = {
    transferId,
    userId,
    kind: "withdrawal",
    status: "signed",
    network: rail.network,
    cluster: rail.cluster,
    mint: rail.mint,
    amount: input.amount,
    txRef: null,
    destination,
    signerMode: "mock",
    mockSignature: mockSolanaSignature(`${transferId}:${destination}:${input.amount}`),
    requestedAt: now,
    updatedAt: now,
    eventJson: {
      source: "solana-usdc-devnet",
      signer: "mock",
      broadcast: false
    }
  };
  const nextBalance = {
    ...balance,
    availableUsdc: balance.availableUsdc - input.amount,
    pendingWithdrawalUsdc: balance.pendingWithdrawalUsdc + input.amount,
    updatedAt: now
  };

  await store.insertTransfer(transfer);
  await store.saveBalance(nextBalance);
  await store.appendEvent(transferEvent(transfer, "WITHDRAWAL_REQUESTED", "requested", now));
  await store.appendEvent(transferEvent(transfer, "WITHDRAWAL_SIGNED", "signed", now));

  return {
    status: "signed",
    idempotent: false,
    broadcast: false,
    transfer,
    balance: nextBalance,
    rail
  };
}

export async function confirmMockWithdrawal(
  store: DotCastSettlementRailStore,
  env: DotCastSettlementRailEnv,
  input: ConfirmMockWithdrawalInput
): Promise<{
  status: "confirmed";
  idempotent: boolean;
  transfer: DotCastSettlementTransfer;
  balance: DotCastSettlementBalance;
  rail: DotCastSettlementRailStatus;
}> {
  const rail = assertDevnetMockRail(env);
  const now = input.now ?? new Date().toISOString();
  const transferId = requireText(input.transferId, "transferId");
  const transfer = await store.getTransfer(transferId);

  if (transfer?.kind !== "withdrawal") {
    throw new DotCastSettlementRailError("WITHDRAWAL_NOT_FOUND", "withdrawal was not found", 404);
  }

  if (transfer.status === "confirmed") {
    return {
      status: "confirmed",
      idempotent: true,
      transfer,
      balance: await readSettlementBalance(store, transfer.userId, now),
      rail
    };
  }

  if (transfer.status !== "signed" && transfer.status !== "requested") {
    throw new DotCastSettlementRailError(
      "WITHDRAWAL_NOT_CONFIRMABLE",
      "withdrawal is not in a confirmable state",
      409
    );
  }

  const confirmed: DotCastSettlementTransfer = {
    ...transfer,
    status: "confirmed",
    txRef:
      nullableText(input.txRef?.trim()) ??
      `mock-confirm:${transfer.mockSignature ?? transfer.transferId}`,
    updatedAt: now,
    eventJson: {
      ...transfer.eventJson,
      confirmedAt: now
    }
  };
  const balance = await readSettlementBalance(store, transfer.userId, now);
  const nextBalance = {
    ...balance,
    pendingWithdrawalUsdc: Math.max(0, balance.pendingWithdrawalUsdc - transfer.amount),
    updatedAt: now
  };

  await store.updateTransfer(confirmed);
  await store.saveBalance(nextBalance);
  await store.appendEvent(transferEvent(confirmed, "WITHDRAWAL_CONFIRMED", "confirmed", now));

  return {
    status: "confirmed",
    idempotent: false,
    transfer: confirmed,
    balance: nextBalance,
    rail
  };
}

export async function reconcileDevnetSettlementRail(
  store: DotCastSettlementRailStore,
  env: DotCastSettlementRailEnv,
  input: ReconcileDevnetRailInput
): Promise<{
  rail: DotCastSettlementRailStatus;
  custodiedAmount: number;
  internalLiabilityUsdc: number;
  availableUsdc: number;
  pendingDepositUsdc: number;
  pendingWithdrawalUsdc: number;
  lockedPoolUsdc: number;
  lockedBondUsdc: number;
  driftUsdc: number;
  reconciledAt: string;
}> {
  const rail = assertDevnetMockRail(env);
  const now = input.now ?? new Date().toISOString();
  assertNonNegativeInteger(input.custodiedAmount, "custodiedAmount");

  const balances = await store.listBalances();
  const totals = balances.reduce(
    (acc, balance) => ({
      availableUsdc: acc.availableUsdc + balance.availableUsdc,
      pendingDepositUsdc: acc.pendingDepositUsdc + balance.pendingDepositUsdc,
      pendingWithdrawalUsdc: acc.pendingWithdrawalUsdc + balance.pendingWithdrawalUsdc,
      lockedPoolUsdc: acc.lockedPoolUsdc + balance.lockedPoolUsdc,
      lockedBondUsdc: acc.lockedBondUsdc + balance.lockedBondUsdc
    }),
    {
      availableUsdc: 0,
      pendingDepositUsdc: 0,
      pendingWithdrawalUsdc: 0,
      lockedPoolUsdc: 0,
      lockedBondUsdc: 0
    }
  );
  const internalLiabilityUsdc =
    totals.availableUsdc +
    totals.pendingWithdrawalUsdc +
    totals.lockedPoolUsdc +
    totals.lockedBondUsdc;
  const driftUsdc = input.custodiedAmount - internalLiabilityUsdc;

  await store.appendEvent({
    eventId: `dotcast:e5:reconciliation:${Date.parse(now)}:${input.custodiedAmount}:${internalLiabilityUsdc}`,
    userId: "system",
    eventType: "RECONCILIATION",
    network: rail.network,
    cluster: rail.cluster,
    mint: rail.mint,
    amount: input.custodiedAmount,
    txRef: null,
    withdrawalId: null,
    status: "reconciled",
    reason: driftUsdc === 0 ? "BALANCED" : "DRIFT",
    eventJson: {
      ...totals,
      internalLiabilityUsdc,
      driftUsdc
    },
    createdAt: now
  });

  return {
    rail,
    custodiedAmount: input.custodiedAmount,
    internalLiabilityUsdc,
    ...totals,
    driftUsdc,
    reconciledAt: now
  };
}

function assertDevnetMockRail(env: DotCastSettlementRailEnv): DotCastSettlementRailStatus {
  const rail = readSolanaUsdcSettlementRailStatus(env);

  if (rail.mode === "disabled") {
    throw new DotCastSettlementRailError(
      "SETTLEMENT_RAIL_DISABLED",
      "E5 settlement rail is disabled",
      503
    );
  }

  if (rail.mode !== "devnet" || rail.cluster !== "devnet") {
    throw new DotCastSettlementRailError(
      "MAINNET_WITHDRAWALS_BLOCKED",
      "E5 only permits Solana USDC devnet mock-settlement operations; mainnet withdrawals require operator approval",
      403
    );
  }

  if (rail.signerMode !== "mock") {
    throw new DotCastSettlementRailError(
      "MOCK_SIGNER_REQUIRED",
      "E5 devnet settlement rail requires the mock signer",
      503
    );
  }

  if (!rail.ready) {
    throw new DotCastSettlementRailError(
      "SETTLEMENT_RAIL_NOT_READY",
      rail.guards[0] ?? "E5 settlement rail is not ready",
      503
    );
  }

  return rail;
}

function transferEvent(
  transfer: DotCastSettlementTransfer,
  eventType: DotCastSettlementRailEvent["eventType"],
  status: DotCastSettlementTransferStatus,
  createdAt: string
): DotCastSettlementRailEvent {
  return {
    eventId: `${transfer.transferId}:${eventType.toLowerCase()}`,
    userId: transfer.userId,
    eventType,
    network: transfer.network,
    cluster: transfer.cluster,
    mint: transfer.mint,
    amount: transfer.amount,
    txRef: transfer.txRef,
    withdrawalId: transfer.kind === "withdrawal" ? transfer.transferId : null,
    status,
    reason: null,
    eventJson: transfer.eventJson,
    createdAt
  };
}

function emptyBalance(userId: string, now: string): DotCastSettlementBalance {
  return {
    userId,
    availableUsdc: 0,
    pendingDepositUsdc: 0,
    pendingWithdrawalUsdc: 0,
    lockedPoolUsdc: 0,
    lockedBondUsdc: 0,
    updatedAt: now
  };
}

function parseRailMode(value: string | undefined): DotCastSettlementRailStatus["mode"] {
  if (value === "devnet" || value === "mainnet" || value === "disabled") {
    return value;
  }

  return "disabled";
}

function parseCluster(
  value: string | undefined,
  mode: DotCastSettlementRailStatus["mode"]
): DotCastSolanaCluster {
  if (value === "devnet" || value === "mainnet-beta") {
    return value;
  }

  return mode === "mainnet" ? "mainnet-beta" : "devnet";
}

function parseSignerMode(
  value: string | undefined,
  mode: DotCastSettlementRailStatus["mode"]
): DotCastSettlementSignerMode {
  if (value === "mock" || value === "external") {
    return value;
  }

  return mode === "devnet" ? "mock" : "unknown";
}

function parsePositiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requireText(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new DotCastSettlementRailError("INVALID_SETTLEMENT_INPUT", `${label} is required`, 400);
}

function assertPositiveAmount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DotCastSettlementRailError(
      "INVALID_SETTLEMENT_AMOUNT",
      `${label} must be a positive integer minor-unit amount`,
      400
    );
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DotCastSettlementRailError(
      "INVALID_SETTLEMENT_INTEGER",
      `${label} must be a non-negative integer`,
      400
    );
  }
}

function isLikelySolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function mockSolanaSignature(seed: string): string {
  return `mock-solana-devnet-${hashText(seed)}`;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function balanceFromRow(row: Record<string, unknown>): DotCastSettlementBalance {
  return {
    userId: String(row.user_id),
    availableUsdc: Number(row.available_usdc ?? 0),
    pendingDepositUsdc: Number(row.pending_deposit_usdc ?? 0),
    pendingWithdrawalUsdc: Number(row.pending_withdrawal_usdc ?? 0),
    lockedPoolUsdc: Number(row.locked_pool_usdc ?? 0),
    lockedBondUsdc: Number(row.locked_bond_usdc ?? 0),
    updatedAt: String(row.updated_at)
  };
}

function transferFromRow(row: Record<string, unknown>): DotCastSettlementTransfer {
  return {
    transferId: String(row.transfer_id),
    userId: String(row.user_id),
    kind: row.kind === "withdrawal" ? "withdrawal" : "deposit",
    status: parseTransferStatus(row.status),
    network: row.network === "solana-mainnet-beta" ? "solana-mainnet-beta" : "solana-devnet",
    cluster: row.cluster === "mainnet-beta" ? "mainnet-beta" : "devnet",
    mint: String(row.mint),
    amount: Number(row.amount ?? 0),
    txRef: nullableText(row.tx_ref),
    destination: nullableText(row.destination),
    signerMode: parseSignerMode(
      row.signer_mode === undefined ? undefined : String(row.signer_mode),
      "disabled"
    ),
    mockSignature: nullableText(row.mock_signature),
    requestedAt: String(row.requested_at),
    updatedAt: String(row.updated_at),
    eventJson: parseJsonObject(row.event_json)
  };
}

function parseTransferStatus(value: unknown): DotCastSettlementTransferStatus {
  if (
    value === "observed" ||
    value === "credited" ||
    value === "reorged" ||
    value === "requested" ||
    value === "signed" ||
    value === "confirmed" ||
    value === "failed"
  ) {
    return value;
  }

  return "observed";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function transferParams(transfer: DotCastSettlementTransfer): unknown[] {
  return [
    transfer.transferId,
    transfer.userId,
    transfer.kind,
    transfer.status,
    transfer.network,
    transfer.cluster,
    transfer.mint,
    transfer.amount,
    transfer.txRef,
    transfer.destination,
    transfer.signerMode,
    transfer.mockSignature,
    transfer.requestedAt,
    transfer.updatedAt,
    JSON.stringify(transfer.eventJson)
  ];
}
