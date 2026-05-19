import type { OrderBookSide, PriceLevel } from "../../../types";

export const CRYPTO_DECIMAL_PLACES = 8;
export const DEFAULT_ORDER_BOOK_TICK_SIZE = 0.00000001;
export const PRICE_SCALE = 100_000_000;

export class SortedBookSide {
  private root: BookNode | null = null;
  private readonly nodes = new Map<number, BookNode>();

  constructor(private readonly side: OrderBookSide) {}

  get size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.root = null;
    this.nodes.clear();
  }

  upsert(price: number, size: number, updatedAt: string, tickSize: number): void {
    if (size < 0) {
      throw new Error("INVALID_ORDER_BOOK_SIZE");
    }

    const key = priceKey(bucketPrice(price, tickSize, this.side));
    const rawKey = priceKey(price);
    const roundedSize = roundCrypto(size);

    if (size === 0) {
      this.deleteRawLevel(key, rawKey);
      return;
    }

    const existing = this.nodes.get(key);

    if (existing) {
      existing.rawSizes.set(rawKey, roundedSize);
      existing.level.size = sumRawSizes(existing.rawSizes);
      existing.level.updatedAt = updatedAt;
      return;
    }

    const node: BookNode = {
      key,
      priority: priorityForKey(key),
      level: {
        price: priceFromKey(key),
        size: roundedSize,
        updatedAt
      },
      rawSizes: new Map([[rawKey, roundedSize]]),
      left: null,
      right: null
    };

    this.nodes.set(key, node);
    this.root = insertBookNode(this.root, node);
  }

  top(limit: number): PriceLevel[] {
    const levels: PriceLevel[] = [];
    collectTopLevels(this.root, this.side, limit, levels);
    return levels;
  }

  range(minimum: number, maximum: number, limit: number): PriceLevel[] {
    const levels: PriceLevel[] = [];
    collectRangeLevels(this.root, this.side, priceKey(minimum), priceKey(maximum), limit, levels);
    return levels;
  }

  private deleteRawLevel(key: number, rawKey: number): void {
    const existing = this.nodes.get(key);

    if (!existing) {
      return;
    }

    existing.rawSizes.delete(rawKey);

    if (existing.rawSizes.size > 0) {
      existing.level.size = sumRawSizes(existing.rawSizes);
      return;
    }

    this.nodes.delete(key);
    this.root = deleteBookNode(this.root, key);
  }
}

interface BookNode {
  key: number;
  priority: number;
  level: PriceLevel;
  rawSizes: Map<number, number>;
  left: BookNode | null;
  right: BookNode | null;
}

export function priceKey(price: number): number {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error("INVALID_ORDER_BOOK_PRICE");
  }

  return Math.round(price * PRICE_SCALE);
}

export function priceFromKey(key: number): number {
  return roundCrypto(key / PRICE_SCALE);
}

export function roundCrypto(value: number): number {
  return roundMetric(value, CRYPTO_DECIMAL_PLACES);
}

export function normalizePriceToTick(
  value: number,
  tickSize: number,
  mode: "FLOOR" | "CEIL"
): number {
  const normalizedTick =
    Number.isFinite(tickSize) && tickSize > 0 ? tickSize : DEFAULT_ORDER_BOOK_TICK_SIZE;
  const scaled =
    mode === "FLOOR" ? Math.floor(value / normalizedTick) : Math.ceil(value / normalizedTick);

  return roundCrypto(Math.max(normalizedTick, scaled * normalizedTick));
}

export function bucketPrice(price: number, tickSize: number, side: OrderBookSide): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return roundCrypto(price);
  }

  const scaled = price / tickSize;
  const bucketed = side === "bid" ? Math.floor(scaled) * tickSize : Math.ceil(scaled) * tickSize;

  return roundCrypto(bucketed);
}

function sumRawSizes(rawSizes: Map<number, number>): number {
  let total = 0;

  for (const size of rawSizes.values()) {
    total += size;
  }

  return roundCrypto(total);
}

function insertBookNode(root: BookNode | null, node: BookNode): BookNode {
  if (!root) {
    return node;
  }

  if (node.key < root.key) {
    root.left = insertBookNode(root.left, node);
    if (root.left.priority < root.priority) {
      return rotateRight(root);
    }
  } else if (node.key > root.key) {
    root.right = insertBookNode(root.right, node);
    if (root.right.priority < root.priority) {
      return rotateLeft(root);
    }
  }

  return root;
}

function deleteBookNode(root: BookNode | null, key: number): BookNode | null {
  if (!root) {
    return null;
  }

  if (key < root.key) {
    root.left = deleteBookNode(root.left, key);
    return root;
  }

  if (key > root.key) {
    root.right = deleteBookNode(root.right, key);
    return root;
  }

  return mergeBookNodes(root.left, root.right);
}

function mergeBookNodes(left: BookNode | null, right: BookNode | null): BookNode | null {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  if (left.priority < right.priority) {
    left.right = mergeBookNodes(left.right, right);
    return left;
  }

  right.left = mergeBookNodes(left, right.left);
  return right;
}

function rotateLeft(root: BookNode): BookNode {
  const pivot = root.right;

  if (!pivot) {
    return root;
  }

  root.right = pivot.left;
  pivot.left = root;
  return pivot;
}

function rotateRight(root: BookNode): BookNode {
  const pivot = root.left;

  if (!pivot) {
    return root;
  }

  root.left = pivot.right;
  pivot.right = root;
  return pivot;
}

function collectTopLevels(
  node: BookNode | null,
  side: OrderBookSide,
  limit: number,
  output: PriceLevel[]
): void {
  if (!node || output.length >= limit) {
    return;
  }

  if (side === "bid") {
    collectTopLevels(node.right, side, limit, output);
    if (output.length < limit) {
      output.push(node.level);
    }
    collectTopLevels(node.left, side, limit, output);
    return;
  }

  collectTopLevels(node.left, side, limit, output);
  if (output.length < limit) {
    output.push(node.level);
  }
  collectTopLevels(node.right, side, limit, output);
}

function collectRangeLevels(
  node: BookNode | null,
  side: OrderBookSide,
  minimumKey: number,
  maximumKey: number,
  limit: number,
  output: PriceLevel[]
): void {
  if (!node || output.length >= limit) {
    return;
  }

  if (side === "bid") {
    if (node.key < maximumKey) {
      collectRangeLevels(node.right, side, minimumKey, maximumKey, limit, output);
    }

    if (output.length < limit && node.key >= minimumKey && node.key <= maximumKey) {
      output.push(node.level);
    }

    if (node.key > minimumKey) {
      collectRangeLevels(node.left, side, minimumKey, maximumKey, limit, output);
    }
    return;
  }

  if (node.key > minimumKey) {
    collectRangeLevels(node.left, side, minimumKey, maximumKey, limit, output);
  }

  if (output.length < limit && node.key >= minimumKey && node.key <= maximumKey) {
    output.push(node.level);
  }

  if (node.key < maximumKey) {
    collectRangeLevels(node.right, side, minimumKey, maximumKey, limit, output);
  }
}

function priorityForKey(key: number): number {
  const text = String(key);
  let hash = 2_166_136_261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

export function roundMetric(value: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  return Math.round(value * scale) / scale;
}
