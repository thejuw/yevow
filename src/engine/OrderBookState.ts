export interface CountableBookSide {
  readonly size: number;
}

export function countOrderBookLevels(
  bids: Iterable<CountableBookSide>,
  asks: Iterable<CountableBookSide>
): number {
  let count = 0;

  for (const book of bids) {
    count += book.size;
  }

  for (const book of asks) {
    count += book.size;
  }

  return count;
}
