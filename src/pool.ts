/**
 * Bounded-concurrency runner. Replaces unbounded Promise.all fan-out so we
 * control memory (HTML + DOM + JSX trees resident at once) and CPU overlap.
 * A worker rejection sets a flag to stop other runners from claiming new items,
 * while preserving propagation of the rejection to the caller.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  let failed = false;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < size; i++) {
    runners.push(
      (async (): Promise<void> => {
        for (;;) {
          if (failed) return;
          const index = cursor++;
          if (index >= items.length) return;
          const item = items[index];
          if (item === undefined) return;
          try {
            await worker(item, index);
          } catch (e) {
            failed = true;
            throw e;
          }
        }
      })(),
    );
  }
  await Promise.all(runners);
}
