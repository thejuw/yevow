export interface TradingIngestQueueTarget {
  ingestQueue: Promise<void>;
}

export function enqueueTradingIngestJob<T>(
  target: TradingIngestQueueTarget,
  jobFactory: () => Promise<T>
): Promise<T> {
  const job = target.ingestQueue.then(jobFactory);
  target.ingestQueue = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}
