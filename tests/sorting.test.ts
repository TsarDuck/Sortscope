import assert from "node:assert/strict";
import test from "node:test";
import {
  BOGO_MAX_ATTEMPTS,
  advanceBogoSession,
  analyzeBubbleSort,
  analyzeCocktailSort,
  analyzeHeapSort,
  analyzeInsertionSort,
  analyzeMergeSort,
  analyzePdqSort,
  analyzePowerSort,
  analyzeQuickSort,
  analyzeSelectionSort,
  buildBogoSteps,
  buildBubbleSteps,
  buildCocktailSteps,
  buildHeapSortSteps,
  buildInsertionSteps,
  buildMergeSortSteps,
  buildPdqSortSteps,
  buildPowerSortSteps,
  buildQuickSortSteps,
  buildSelectionSteps,
  createBogoSession,
  getBogoSessionStep,
  isNonDecreasing,
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

test("bubble, cocktail, selection, heap, quick, PDQ, merge, and Powersort finish in numeric order without mutating the source", () => {
  const builders = [
    buildBubbleSteps,
    buildCocktailSteps,
    buildSelectionSteps,
    buildHeapSortSteps,
    buildQuickSortSteps,
    buildPdqSortSteps,
    buildMergeSortSteps,
    buildPowerSortSteps,
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

test("quick sort marks in-place values for rendering without changing its work totals", () => {
  const source = [3, 1, 2, 4, 5];
  const steps = buildQuickSortSteps(source);
  const metrics = analyzeQuickSort(source);
  const firstStep = steps[0];
  const finalStep = steps.at(-1);

  // 4 and 5 begin in their final slots, even though neither needs to be the
  // first pivot. This is a renderer-only hint, not a sorting operation.
  assert.deepEqual(firstStep.visualSettled, [3, 4]);
  assert.deepEqual(finalStep?.visualSettled, [0, 1, 2, 3, 4]);
  assert.equal(finalStep?.comparisons, metrics.comparisons);
  assert.equal(finalStep?.writes, metrics.writes);
});

test("PDQ sort keeps its visual hints separate from its counted work", () => {
  const source = [8, 1, 7, 3, 6, 2, 5, 4];
  const steps = buildPdqSortSteps(source);
  const metrics = analyzePdqSort(source);

  assert.deepEqual(finalValues(steps), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(steps.at(-1)?.comparisons, metrics.comparisons);
  assert.equal(steps.at(-1)?.writes, metrics.writes);
  assert.ok((steps[0]?.visualSettled?.length ?? 0) >= 0);
  assert.deepEqual(source, [8, 1, 7, 3, 6, 2, 5, 4]);
});

test("Powersort detects natural runs and keeps builder metrics aligned with its analyzer", () => {
  const source = [1, 4, 7, 10, 2, 5, 8, 11, 3, 6, 9, 12, 13, 14, 15, 16];
  const steps = buildPowerSortSteps(source);
  const metrics = analyzePowerSort(source);
  const powerFrames = steps.filter((step) => step.phase === "power");

  assert.deepEqual(finalValues(steps), [...source].sort((left, right) => left - right));
  assert.equal(steps.at(-1)?.comparisons, metrics.comparisons);
  assert.equal(steps.at(-1)?.writes, metrics.writes);
  assert.ok(steps.some((step) => step.phase === "run"));
  assert.ok(powerFrames.some((step) => (step.nodePower ?? 0) >= 1));

  const alreadySorted = buildPowerSortSteps(Array.from({ length: 32 }, (_, index) => index + 1));
  assert.equal(alreadySorted.filter((step) => step.phase === "merge").length, 0);
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
  assert.deepEqual(analyzePdqSort(source).finalValues, expected);
  assert.deepEqual(analyzeMergeSort(source).finalValues, expected);
  assert.deepEqual(analyzePowerSort(source).finalValues, expected);
  assert.deepEqual(source, Array.from({ length: 256 }, (_, index) => 256 - index));
});
