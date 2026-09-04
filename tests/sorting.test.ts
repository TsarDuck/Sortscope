import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCocktailSort,
  analyzeInsertionSort,
  analyzeMeanPartitionSort,
  analyzeMergeSort,
  analyzeQuickSort,
  buildBogoSteps,
  buildCocktailSteps,
  buildInsertionSteps,
  buildMeanPartitionSteps,
  buildMergeSortSteps,
  buildQuickSortSteps,
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

test("cocktail, quick, and merge sort finish in numeric order without mutating the source", () => {
  const builders = [buildCocktailSteps, buildQuickSortSteps, buildMergeSortSteps];
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

test("bogo sort either succeeds by shuffle or reports its safety limit honestly", () => {
  const source = [2, 1];
  const success = buildBogoSteps(source, 4, () => 0);
  const limited = buildBogoSteps(source, 3, () => 0.999);

  assert.deepEqual(source, [2, 1]);
  assert.deepEqual(finalValues(success), [1, 2]);
  assert.equal(success.at(-1)?.phase, "complete");
  assert.equal(limited.at(-1)?.phase, "limited");
  assert.equal(isNonDecreasing(finalValues(limited)), false);
});

test("sorting metric analyzers preserve a clean 1 through 256 final line", () => {
  const source = Array.from({ length: 256 }, (_, index) => 256 - index);
  const expected = Array.from({ length: 256 }, (_, index) => index + 1);

  assert.deepEqual(analyzeInsertionSort(source).finalValues, expected);
  assert.deepEqual(analyzeCocktailSort(source).finalValues, expected);
  assert.deepEqual(analyzeQuickSort(source).finalValues, expected);
  assert.deepEqual(analyzeMergeSort(source).finalValues, expected);
  assert.deepEqual(analyzeMeanPartitionSort(source).finalValues, expected);
  assert.deepEqual(source, Array.from({ length: 256 }, (_, index) => 256 - index));
});
