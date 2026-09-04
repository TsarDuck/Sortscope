import assert from "node:assert/strict";
import test from "node:test";
import {
  BOGO_MAX_ATTEMPTS,
  advanceBogoSession,
  analyzeBubbleSort,
  analyzeCocktailSort,
  analyzeHeapSort,
  analyzeInsertionSort,
  analyzeMeanPartitionSort,
  analyzeRangeGuardMeanSort,
  analyzeMergeSort,
  analyzeQuickSort,
  analyzeSelectionSort,
  buildBogoSteps,
  buildBubbleSteps,
  buildCocktailSteps,
  buildHeapSortSteps,
  buildInsertionSteps,
  buildMeanPartitionSteps,
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

test("insertion sort finishes in numeric order without mutating its source", () => {
  const source = [3, 1, 2];
  const steps = buildInsertionSteps(source);

  assert.deepEqual(source, [3, 1, 2]);
  assert.deepEqual(finalValues(steps), [1, 2, 3]);
  assert.equal(steps.at(-1)?.comparisons, 3);
  assert.equal(steps.at(-1)?.writes, 4);
});

test("mean partition sort refines blocks until it reaches numeric order", () => {
  const source = [1, 100, 49, 50];
  const steps = buildMeanPartitionSteps(source);
  const splitSteps = steps.filter((step) => step.phase === "split");

  assert.deepEqual(source, [1, 100, 49, 50]);
  assert.deepEqual(
    splitSteps.map((step) => step.groups?.length),
    [2, 4],
  );
  assert.deepEqual(finalValues(steps), [1, 49, 50, 100]);
  assert.equal(isNonDecreasing(finalValues(steps)), true);
});

test("range-guard mean saves its overlap guard for adaptive small groups", () => {
  const source = [1, 16, 2, 15, 3, 14, 4, 13, 5, 12, 6, 11, 7, 10, 8, 9];
  const steps = buildRangeGuardMeanSteps(source);
  const splitSteps = steps.filter((step) => step.phase === "split");

  assert.deepEqual(splitSteps.slice(0, 2).map((step) => step.groups?.length), [2, 4]);
  assert.ok(splitSteps[1].groups?.every((group) => group.end - group.start === 4));
  assert.match(splitSteps[2].message, /overlap guard/);
  assert.deepEqual(finalValues(steps), [...source].sort((left, right) => left - right));
  assert.ok((analyzeRangeGuardMeanSort(source).refinementOperations ?? 0) > 0);
});

test("mean partition remains the simple baseline while range-guard mean refines overlaps", () => {
  const source = [1, 16, 2, 15, 3, 14, 4, 13, 5, 12, 6, 11, 7, 10, 8, 9];
  const baseline = buildMeanPartitionSteps(source);
  const guarded = buildRangeGuardMeanSteps(source);

  assert.equal(baseline.some((step) => step.message.includes("overlap guard")), false);
  assert.equal(guarded.some((step) => step.message.includes("overlap guard")), true);
  assert.equal(analyzeMeanPartitionSort(source).refinementOperations, 0);
  assert.deepEqual(finalValues(baseline), [...source].sort((left, right) => left - right));
  assert.deepEqual(finalValues(guarded), [...source].sort((left, right) => left - right));
});

test("balanced partitions cover every value without creating empty groups", () => {
  assert.deepEqual(partitionBalanced([1, 2, 3, 4, 5], 4), [[1, 2], [3], [4], [5]]);
  assert.deepEqual(partitionBalanced([1, 2, 3, 4, 5, 6], 4), [[1, 2], [3, 4], [5], [6]]);
});

test("mean partition sort handles duplicates, negatives, and already ordered rows", () => {
  for (const source of [
    [5, 5, 2, 2, 1],
    [-3, 8, -1, 0, 8],
    [1, 2, 3, 4],
  ]) {
    const steps = buildMeanPartitionSteps(source);
    assert.deepEqual(finalValues(steps), [...source].sort((left, right) => left - right));
  }
});

test("mean partition workload includes every grouping read and rebuilt output", () => {
  const sorted = analyzeMeanPartitionSort([1, 2, 3, 4]);
  const reverse = analyzeMeanPartitionSort([4, 3, 2, 1]);

  assert.equal(sorted.meanComputationOperations, 6);
  assert.equal(sorted.writes, 4);
  assert.equal(reverse.meanComputationOperations, 14);
  assert.equal(reverse.writes, 8);
  assert.ok(reverse.rankComparisons > sorted.rankComparisons);
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

  assert.equal(success.attemptLimit, 4);
  assert.equal(getBogoSessionStep(success).phase, "complete");
  assert.deepEqual(getBogoSessionStep(success).values, [1, 2]);
  assert.equal(limited.attempts, 3);
  assert.equal(getBogoSessionStep(limited).phase, "limited");
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
  assert.deepEqual(analyzeMeanPartitionSort(source).finalValues, expected);
  assert.deepEqual(analyzeRangeGuardMeanSort(source).finalValues, expected);
  assert.deepEqual(source, Array.from({ length: 256 }, (_, index) => 256 - index));
});
