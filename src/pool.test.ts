import { expect, test } from "vitest";
import { runPool } from "./pool.js";

test("runPool processes every item exactly once", async () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const seen = new Set<number>();
  await runPool(items, 4, async (n) => {
    await Promise.resolve();
    seen.add(n);
  });
  expect(seen.size).toBe(50);
});

test("runPool respects the concurrency cap", async () => {
  let active = 0;
  let peak = 0;
  await runPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  });
  expect(peak).toBeLessThanOrEqual(3);
  expect(peak).toBeGreaterThan(0);
});

test("runPool propagates worker errors", async () => {
  await expect(
    runPool([1, 2, 3], 2, async (n) => {
      await Promise.resolve();
      if (n === 2) throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
});

test("runPool handles empty input", async () => {
  await runPool([], 4, async () => {
    await Promise.resolve();
    throw new Error("must not run");
  });
});

test("runPool stops claiming items after a worker rejects", async () => {
  const items = [1, 2, 3, 4, 5];
  const executed: number[] = [];
  await expect(
    runPool(items, 2, async (n) => {
      executed.push(n);
      if (n === 2) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 10));
    }),
  ).rejects.toThrow("boom");
  // Should have executed 1 and 2 (and maybe 3 if it was already claimed), but not 4 or 5
  expect(executed.some((n) => n >= 4)).toBe(false);
});
