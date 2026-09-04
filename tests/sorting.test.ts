import assert from "node:assert/strict";
import test from "node:test";
import {
  BOGO_MAX_ATTEMPTS,
  advanceBogoSession,
  analyzeBubbleSort,
  analyzeCocktailSort,
  analyzeHeapSort,
  analyzeInsertionSort,
  analyzeRangeGuardMeanSort,
  analyzeMergeSort,
  analyzeQuickSort,
  analyzeSelectionSort,
  buildBogoSteps,
  buildBubbleSteps,
  buildCocktailSteps,
  buildHeapSortSteps,
  buildInsertionSteps,
  buildRangeGuardMeanSteps,
  buildMergeSortSteps,
  buildQuickSortSteps,
  buildSelectionSteps,
  createBogoSession,
  getBogoSessionStep,
  isNonDecreasing,
  partitionBalanced,
} from "../app/lib/sorting";

function finalValues(steps: Array<{ values: number[] }>) {
  return steps.at(-1)?.values ?? [];
}

function makeBenchmarkValues(length: number, pattern: "random" | "reverse" | "nearly-sorted") {
  const values = Array.from({ length }, (_, index) => index + 1);

  if (pattern === "reverse") return values.reverse();

  if (pattern === "nearly-sorted") {
    const swapCount = Math.max(2, Math.floor(length * 0.08));
    for (let index = 0; index < swapCount; index += 1) {
      const left = (index * 17 + 3) % length;
      const right = (index * 29 + 7) % length;
      [values[left], values[right]] = [values[right], values[left]];
    }
    return values;
  }

  let seed = length * 7919 + 17;
  for (let index = values.length - 1; index > 0; index -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const swapIndex = seed % (index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }

  return values;
}

function totalWork(metrics: {
  comparisons: number;
  rankComparisons: number;
  writes: number;
  meanComputationOperations?: number;
  meanRankingArithmeticOperations?: number;
  refinementOperations?: number;
}) {
  return (
    metrics.comparisons +
    metrics.rankComparisons +
    metrics.writes +
    (metrics.meanComputationOperations ?? 0) +
    (metrics.meanRankingArithmeticOperations ?? 0) +
    (metrics.refinementOperations ?? 0)
  );
}

test("insertion sort finishes in numeric order without mutating its source", () => {
  const source = [3, 1, 2];
  const steps = buildInsertionSteps(source);

  assert.deepEqual(source, [3, 1, 2]);
  assert.deepEqual(finalValues(steps), [1, 2, 3]);
  assert.equal(steps.at(-1)?.comparisons, 3);
  assert.equal(steps.at(-1)?.writes, 4);
});

test("adaptive mean uses a size-scaled mean cascade before its certified local finish", () => {
  const source = Array.from(
    { length: 64 },
    (_, index) => (index % 2 === 0 ? index / 2 + 1 : 64 - (index - 1) / 2),
  );
  const steps = buildRangeGuardMeanSteps(source);
  const splitSteps = steps.filter((step) => step.phase === "split");

  assert.deepEqual(
    splitSteps.slice(0, 3).map((step) => step.groups?.length),
    [2, 4, 8],
  );
  assert.match(splitSteps[0]?.message ?? "", /Mean cascade round 1/);
  assert.match(splitSteps[3]?.message ?? "", /Adaptive mean guard finds/);
  assert.deepEqual(finalValues(steps), [...source].sort((left, right) => left - right));
  const metrics = analyzeRangeGuardMeanSort(source);
  assert.equal(metrics.comparisons, 0);
  assert.ok(metrics.rankComparisons > 0);
  assert.ok((metrics.meanComputationOperations ?? 0) > 0);
  assert.ok((metrics.meanRankingArithmeticOperations ?? 0) > 0);
  assert.ok((metrics.refinementOperations ?? 0) > 0);
  assert.ok(steps.filter((step) => step.phase === "reorder").length > 3);
  assert.deepEqual(source, Array.from(
    { length: 64 },
    (_, index) => (index % 2 === 0 ? index / 2 + 1 : 64 - (index - 1) / 2),
  ));
});

test("adaptive mean respects duplicate-safe range boundaries", () => {
  const source = [
    16, 1, 15, 2, 14, 3, 13, 4, 12, 5, 11, 6, 10, 7, 9, 8,
    31, 16, 30, 17, 29, 18, 28, 19, 27, 20, 26, 21, 25, 22, 24, 23,
  ];
  const guarded = buildRangeGuardMeanSteps(source);
  const rangeScan = guarded.find(
    (step) => step.phase === "split" && step.message.includes("Adaptive mean guard finds"),
  );

  assert.match(rangeScan?.message ?? "", /2 certified independent value regions/);
  assert.equal(rangeScan?.groups?.length, 2);
  assert.deepEqual(finalValues(guarded), [...source].sort((left, right) => left - right));
});

test("adaptive mean finishes generic values exactly without mutating its source", () => {
  for (const source of [
    [5, 5, 2, 2, 1, -3, 8, -1, 0, 8],
    [3.5, -1.25, 3.5, 0, -8.75, 2.25, 2.25],
    Array.from({ length: 33 }, (_, index) => (index * 11) % 29 - 14),
    Array.from({ length: 255 }, (_, index) => ((index * 73) % 97) - 48),
  ]) {
    const before = [...source];
    const expected = [...source].sort((left, right) => left - right);

    assert.deepEqual(finalValues(buildRangeGuardMeanSteps(source)), expected);
    assert.deepEqual(analyzeRangeGuardMeanSort(source).finalValues, expected);
    assert.deepEqual(source, before);
  }
});

test("balanced partitions cover every value without creating empty groups", () => {
  assert.deepEqual(partitionBalanced([1, 2, 3, 4, 5], 4), [[1, 2], [3], [4], [5]]);
  assert.deepEqual(partitionBalanced([1, 2, 3, 4, 5, 6], 4), [[1, 2], [3, 4], [5], [6]]);
});

test("adaptive mean stays below heap on the Efficiency Lab arrangements", () => {
  for (const size of [16, 32, 64, 128, 256]) {
    for (const pattern of ["random", "reverse", "nearly-sorted"] as const) {
      const values = makeBenchmarkValues(size, pattern);
      const guardedWork = totalWork(analyzeRangeGuardMeanSort(values));
      const heapWork = totalWork(analyzeHeapSort(values));

      assert.ok(
        guardedWork < heapWork,
        "Expected Adaptive Mean to beat Heap at n=" + size + " for " + pattern + ".",
      );
    }
  }
});

test("bubble, cocktail, selection, heap, quick, and merge sort finish in numeric order without mutating the source", () => {
  const builders = [
    buildBubbleSteps,
    buildCocktailSteps,
    buildSelectionSteps,
    buildHeapSortSteps,
    buildQuickSortSteps,
    buildMergeSortSteps,
  ];
  const sources = [
    [5, 1, 4, 2, 3],
    [4, 4, -1, 3, 0],
    [1, 2, 3, 4],
  ];

  for (const build of builders) {
    for (const source of sources) {
      const before = [...source];
      const steps = build(source);
      assert.deepEqual(source, before);
      assert.deepEqual(finalValues(steps), [...source].sort((left, right) => left - right));
      assert.equal(steps.at(-1)?.phase, "complete");
    }
  }
});

test("dense cocktail and merge frames keep their visual focus scoped", () => {
  const denseSource = Array.from({ length: 65 }, (_, index) => 65 - index);
  const cocktailSweeps = buildCocktailSteps(denseSource).filter(
    (step) => step.phase === "sweep",
  );
  const mergeFrames = buildMergeSortSteps([8, 3, 7, 1, 6, 2, 5, 4]).filter(
    (step) => step.phase === "merge",
  );
  const finalMergeFrames = buildMergeSortSteps(
    Array.from({ length: 256 }, (_, index) => 256 - index),
  ).filter((step) => step.phase === "merge" && step.pass === 8);

  assert.ok(cocktailSweeps.length > 0);
  for (const step of cocktailSweeps) {
    assert.equal(step.shifting, (step.comparing ?? -1) + 1);
  }
  const firstSweep = cocktailSweeps.filter((step) => step.pass === 1);
  assert.ok(firstSweep.length >= 4);
  assert.notEqual(firstSweep.at(0)?.comparing, firstSweep.at(-1)?.comparing);

  assert.ok(mergeFrames.length > 0);
  for (const step of mergeFrames) {
    assert.ok(step.rangeStart !== undefined);
    assert.ok(step.rangeEnd !== undefined);
    assert.ok((step.rangeStart ?? 0) < (step.rangeEnd ?? 0));
  }
  assert.ok(
    mergeFrames.some(
      (step) => (step.rangeEnd ?? 0) - (step.rangeStart ?? 0) < 8,
    ),
  );
  assert.ok(finalMergeFrames.length >= 20);
  assert.equal(finalMergeFrames.at(-1)?.inserting, 255);
});

test("bogo sort either succeeds by shuffle or reports its safety limit honestly", () => {
  const source = [2, 1];
  const success = buildBogoSteps(source, 4, () => 0);
  const limited = buildBogoSteps(source, 3, () => 0.999);
  const largeLimited = buildBogoSteps(
    Array.from({ length: 256 }, (_, index) => 256 - index),
    3,
    () => 0.999,
  );

  assert.deepEqual(source, [2, 1]);
  assert.equal(BOGO_MAX_ATTEMPTS, 1_000_000);
  assert.deepEqual(finalValues(success), [1, 2]);
  assert.equal(success.at(-1)?.phase, "complete");
  assert.equal(limited.at(-1)?.phase, "limited");
  assert.equal(isNonDecreasing(finalValues(limited)), false);
  assert.equal(largeLimited.at(-1)?.phase, "limited");
  assert.equal(finalValues(largeLimited).length, 256);
});

test("bogo sessions can yield between attempts without losing their selected limit", () => {
  const success = createBogoSession([2, 1], 4);
  advanceBogoSession(success, () => 0);

  const limited = createBogoSession([2, 1], 3);
  while (!limited.done) advanceBogoSession(limited, () => 0.999);

  const unlimited = createBogoSession([2, 1], null);
  advanceBogoSession(unlimited, () => 0.999);

  assert.equal(success.attemptLimit, 4);
  assert.equal(getBogoSessionStep(success).phase, "complete");
  assert.deepEqual(getBogoSessionStep(success).values, [1, 2]);
  assert.equal(limited.attempts, 3);
  assert.equal(getBogoSessionStep(limited).phase, "limited");
  assert.equal(unlimited.attemptLimit, null);
  assert.equal(unlimited.done, false);
  assert.equal(unlimited.limited, false);
  assert.equal(getBogoSessionStep(unlimited).phase, "shuffle");

  advanceBogoSession(unlimited, () => 0);
  assert.equal(unlimited.done, true);
  assert.equal(unlimited.limited, false);
  assert.equal(getBogoSessionStep(unlimited).phase, "complete");
});

test("dense algorithms retain a bounded number of useful render snapshots", () => {
  const source = Array.from({ length: 256 }, (_, index) => 256 - index);
  const cocktail = buildCocktailSteps(source);
  const bogo = buildBogoSteps(source, 100, () => 0.999);
  const heap = buildHeapSortSteps(source);

  assert.ok(cocktail.length < 1_300);
  assert.ok(bogo.length < 30);
  assert.ok(heap.length < 600);
  assert.deepEqual(finalValues(cocktail), [...source].reverse());
  assert.deepEqual(finalValues(heap), [...source].reverse());
});

test("rows above the default detail size use compact visual sequences", () => {
  const detailed = Array.from({ length: 24 }, (_, index) => 24 - index);
  const compact = Array.from({ length: 25 }, (_, index) => 25 - index);

  assert.ok(buildCocktailSteps(compact).length < buildCocktailSteps(detailed).length);
  assert.ok(buildQuickSortSteps(compact).length < buildQuickSortSteps(detailed).length);
  assert.ok(buildMergeSortSteps(compact).length < buildMergeSortSteps(detailed).length);
});

test("sorting metric analyzers preserve a clean 1 through 256 final line", () => {
  const source = Array.from({ length: 256 }, (_, index) => 256 - index);
  const expected = Array.from({ length: 256 }, (_, index) => index + 1);

  assert.deepEqual(analyzeInsertionSort(source).finalValues, expected);
  assert.deepEqual(analyzeBubbleSort(source).finalValues, expected);
  assert.deepEqual(analyzeCocktailSort(source).finalValues, expected);
  assert.deepEqual(analyzeSelectionSort(source).finalValues, expected);
  assert.deepEqual(analyzeHeapSort(source).finalValues, expected);
  assert.deepEqual(analyzeQuickSort(source).finalValues, expected);
  assert.deepEqual(analyzeMergeSort(source).finalValues, expected);
  assert.deepEqual(analyzeRangeGuardMeanSort(source).finalValues, expected);
  assert.deepEqual(source, Array.from({ length: 256 }, (_, index) => 256 - index));
});
