"use client";

import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BOGO_MAX_ATTEMPTS,
  type BogoSession,
  advanceBogoSession,
  analyzeCocktailSort,
  analyzeHeapSort,
  analyzeInsertionSort,
  analyzeMeanPartitionSort,
  analyzeMergeSort,
  analyzeQuickSort,
  analyzeSelectionSort,
  buildCocktailSteps,
  buildHeapSortSteps,
  buildMeanPartitionSteps,
  buildMergeSortSteps,
  buildQuickSortSteps,
  buildSelectionSteps,
  createBogoSession,
  formatMean,
  getBogoSessionStep,
} from "./lib/sorting";

type AlgorithmId =
  | "insertion"
  | "cocktail"
  | "selection"
  | "heap"
  | "quick"
  | "merge"
  | "bogo"
  | "mean-partition";
type RunState = "ready" | "running" | "paused" | "complete";
type StepPhase =
  | "ready"
  | "select"
  | "compare"
  | "shift"
  | "insert"
  | "split"
  | "average"
  | "reorder"
  | "swap"
  | "sweep"
  | "heapify"
  | "merge"
  | "shuffle"
  | "limited"
  | "complete";

type MeanGroup = {
  id: number;
  start: number;
  end: number;
  mean: number;
  rank: number;
};

type BenchmarkPattern = "random" | "reverse" | "nearly-sorted";

type BlockPracticeStep = {
  prompt: string;
  start: number[];
  target: number[];
  hint: string;
  kind?: "blocks";
};

type PartitionPracticeStep = {
  prompt: string;
  partitions: Array<{ id: string; values: number[]; mean: number }>;
  targetOrder: string[];
  hint: string;
  kind: "partitions";
};

type PracticeStep = BlockPracticeStep | PartitionPracticeStep;

type SortStep = {
  values: number[];
  pass: number;
  phase: StepPhase;
  key: number | null;
  comparing: number | null;
  shifting: number | null;
  inserting: number | null;
  gapIndex: number | null;
  sortedCount: number;
  comparisons: number;
  writes: number;
  message: string;
  groups?: MeanGroup[];
  settled?: number[];
  rangeStart?: number;
  rangeEnd?: number;
};

const AUDIBLE_PHASES: StepPhase[] = [
  "compare",
  "shift",
  "insert",
  "swap",
  "sweep",
  "heapify",
  "merge",
  "shuffle",
  "reorder",
];

const DEFAULT_ARRAY_SIZE = 24;
const DEFAULT_SPEED = 62;
const BENCHMARK_SIZES = [16, 32, 64, 128, 256];
const BENCHMARK_ALGORITHMS = [
  { key: "insertion", label: "Insertion sort", className: "insertion" },
  { key: "cocktail", label: "Cocktail sort", className: "cocktail" },
  { key: "selection", label: "Selection sort", className: "selection" },
  { key: "heap", label: "Heap sort", className: "heap" },
  { key: "quick", label: "Quick sort", className: "quick" },
  { key: "merge", label: "Merge sort", className: "merge" },
  { key: "meanPartition", label: "Mean partition sort", className: "mean" },
] as const;
type BenchmarkAlgorithm = (typeof BENCHMARK_ALGORITHMS)[number]["key"];
type BenchmarkWork = Record<BenchmarkAlgorithm, number>;
const BOGO_MIN_ATTEMPTS = 1_000;
const BOGO_SMALL_ARRAY_MAX_ATTEMPTS = 999_999_999;
const BOGO_MID_ARRAY_MAX_ATTEMPTS = 100_000_000;
const BOGO_LARGE_ARRAY_MAX_ATTEMPTS = 1_000_000;
const INITIAL_VALUES = [
  17, 5, 22, 8, 19, 3, 14, 24, 1, 12, 7, 20, 10, 23, 4, 16, 9, 21, 2, 18,
  6, 15, 11, 13,
];
const BOGO_CONFETTI_COLORS = ["#ffe98e", "#a9f2be", "#8ee6ff", "#cbb8ff", "#ff9fba", "#ffbd82"];
const BOGO_CONFETTI = Array.from({ length: 64 }, (_, index) => ({
  id: index,
  left: (index * 37 + 11) % 100,
  delay: (index % 16) * 0.07,
  duration: 1.8 + (index % 5) * 0.18,
  color: BOGO_CONFETTI_COLORS[index % BOGO_CONFETTI_COLORS.length],
  shape: index % 3,
}));

function getBogoAttemptMaximum(size: number) {
  if (size < DEFAULT_ARRAY_SIZE) return BOGO_SMALL_ARRAY_MAX_ATTEMPTS;
  if (size <= 144) return BOGO_MID_ARRAY_MAX_ATTEMPTS;

  const scale = (size - 144) / (256 - 144);
  return Math.round(
    BOGO_MID_ARRAY_MAX_ATTEMPTS *
      (BOGO_LARGE_ARRAY_MAX_ATTEMPTS / BOGO_MID_ARRAY_MAX_ATTEMPTS) ** scale,
  );
}

const ALGORITHM_DETAILS: Record<
  AlgorithmId,
  {
    label: string;
    number: string;
    heroCopy: string;
    controlTitle: string;
    stageLabel: string;
    stageDescription: string;
    eyebrow: string;
    learnTitle: string;
    learnCopy: string[];
    complexity: [string, string, string];
    cardTitle: string;
    cardTag: string;
    steps: string[];
    examples: Array<{ values: string; detail: string }>;
    practice: PracticeStep[];
  }
> = {
  insertion: {
    label: "Insertion sort",
    number: "01",
    heroCopy: "Slow down a real insertion sort and see the sorted prefix grow one deliberate move at a time.",
    controlTitle: "Build a sorted prefix",
    stageLabel: "pass",
    stageDescription: "key placement",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Like sorting cards in your hand.",
    learnCopy: [
      "Insertion sort keeps the left side of the row sorted at all times. It then takes the next value from the unsorted side—the key—and finds where that key belongs in the sorted side.",
      "Instead of swapping the key over and over, it shifts every larger value one place right to open a gap. The key drops into that gap. Because the left side was sorted before and the key is inserted in the right spot, the left side is still sorted afterward.",
    ],
    complexity: ["BEST O(n)", "AVERAGE O(n²)", "SPACE O(1)"],
    cardTitle: "INSERTION SORT",
    cardTag: "stable · in-place",
    steps: [
      "Choose the next value as the key.",
      "Compare it to values in the sorted prefix.",
      "Shift larger values right, then insert the key.",
    ],
    examples: [
      { values: "[5 | 3, 4, 1]", detail: "Treat 5 as a one-value sorted prefix; 3 is the next key." },
      { values: "[3, 5 | 4, 1]", detail: "3 is smaller than 5, so 5 slides right and 3 uses the new gap." },
      { values: "[3, 4, 5 | 1]", detail: "Repeat for 4; the sorted prefix grows by one value every pass." },
    ],
    practice: [
      { prompt: "Take 3 and slide it before 5.", start: [5, 3, 4, 1], target: [3, 5, 4, 1], hint: "The key is smaller than the only sorted value." },
      { prompt: "Now place 4 into the sorted prefix.", start: [3, 5, 4, 1], target: [3, 4, 5, 1], hint: "4 belongs between 3 and 5." },
      { prompt: "Slide 1 into its final position in the prefix.", start: [3, 4, 5, 1], target: [1, 3, 4, 5], hint: "1 is smaller than every value already in the prefix." },
    ],
  },
  cocktail: {
    label: "Cocktail sort",
    number: "02",
    heroCopy: "Sweep in both directions so large values drift right while small values travel back left.",
    controlTitle: "Sweep in both directions",
    stageLabel: "sweep",
    stageDescription: "forward or backward pass",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Bubble both ways.",
    learnCopy: [
      "Cocktail sort is bubble sort in two directions. On a forward sweep it compares neighbors from left to right and swaps a pair when the left value is larger. Large values therefore drift toward the right edge.",
      "It then turns around. The backward sweep compares neighbors from right to left, letting small values drift toward the left edge. After a forward and backward pair, both outer edges are more settled, so later sweeps only need to inspect the middle.",
    ],
    complexity: ["BEST O(n)", "AVERAGE O(n²)", "SPACE O(1)"],
    cardTitle: "COCKTAIL SORT",
    cardTag: "stable · in-place",
    steps: [
      "Compare neighboring values while moving right.",
      "Swap out-of-order neighbors to settle the largest value.",
      "Reverse direction to settle the smallest remaining value.",
    ],
    examples: [
      { values: "[4, 1, 3, 2] → [1, 4, 3, 2]", detail: "The first forward comparison finds 4 > 1, so those neighbors trade places." },
      { values: "[1, 4, 3, 2] → [1, 3, 2, 4]", detail: "Continuing right pushes 4 to the far edge, where it is settled." },
      { values: "[1, 3, 2, 4] → [1, 2, 3, 4]", detail: "The backward sweep fixes the small value that needs to travel left." },
    ],
    practice: [
      { prompt: "Start the forward sweep by moving 1 ahead of 4.", start: [4, 1, 3, 2], target: [1, 4, 3, 2], hint: "Compare the first neighboring pair." },
      { prompt: "Finish this forward sweep so 4 reaches the settled right edge.", start: [1, 4, 3, 2], target: [1, 3, 2, 4], hint: "The largest value belongs at the far right after a forward pass." },
      { prompt: "Use the backward sweep to finish the middle pair.", start: [1, 3, 2, 4], target: [1, 2, 3, 4], hint: "The smaller value travels left on the return pass." },
    ],
  },
  selection: {
    label: "Selection sort",
    number: "03",
    heroCopy: "Find the smallest remaining value, place it next, and grow the sorted left edge one choice at a time.",
    controlTitle: "Select the next minimum",
    stageLabel: "selection",
    stageDescription: "minimum placement",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Choose the next spot deliberately.",
    learnCopy: [
      "Selection sort divides the row into a finished left section and an unsorted right section. For each open position on the left, it scans every remaining value to find the smallest one.",
      "Only after the full scan does it place that minimum in the open position. That means it usually performs very few placements—about one per position—but it still performs many comparisons because it repeatedly searches the rest of the row.",
    ],
    complexity: ["BEST O(n²)", "AVERAGE O(n²)", "SPACE O(1)"],
    cardTitle: "SELECTION SORT",
    cardTag: "in-place · choice-based",
    steps: [
      "Start at the first unsorted position.",
      "Scan the remaining values for the smallest one.",
      "Swap that minimum into the next sorted spot.",
    ],
    examples: [
      { values: "[4, 2, 5, 1]", detail: "The first open spot is position 0, so scan all four values for the minimum." },
      { values: "minimum = 1", detail: "1 is remembered as the best candidate only after every remaining value has been checked." },
      { values: "[1 | 2, 5, 4]", detail: "Place 1 first, then repeat the same search for the next open spot." },
    ],
    practice: [
      { prompt: "Place the smallest value, 1, into the first open spot.", start: [4, 2, 5, 1], target: [1, 4, 2, 5], hint: "Selection sort searches the whole row before making this placement." },
      { prompt: "From the remaining values, place 2 in the next open spot.", start: [1, 4, 2, 5], target: [1, 2, 4, 5], hint: "The finished left section should stay untouched." },
    ],
  },
  heap: {
    label: "Heap sort",
    number: "04",
    heroCopy: "Build a max heap, move its largest value to the end, then restore the heap and repeat.",
    controlTitle: "Extract values from a max heap",
    stageLabel: "heap pass",
    stageDescription: "heap extraction",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Keep the largest value on top.",
    learnCopy: [
      "Heap sort treats the row like a compact binary tree. In a max heap, every parent is at least as large as either of its children, so the root at the far left is always the largest active value.",
      "First it rearranges the row into that heap shape. Then it moves the root to the far right, where that largest value is final. A new root may now be too small, so it is sifted downward until the heap rule is restored. The active heap shrinks by one each time.",
    ],
    complexity: ["TIME O(n log n)", "IN-PLACE YES", "SPACE O(1)"],
    cardTitle: "HEAP SORT",
    cardTag: "in-place · heap-based",
    steps: [
      "Build a max heap from the whole row.",
      "Move the root—the largest value—to the right edge.",
      "Sift the new root down and extract again.",
    ],
    examples: [
      { values: "[3, 1, 4, 2] → [4, 2, 3, 1]", detail: "Rearrange the row so the largest value, 4, reaches the tree root." },
      { values: "[1, 2, 3 | 4]", detail: "Move the root to the right; 4 is now in its final sorted position." },
      { values: "[3, 2, 1 | 4]", detail: "Sift the new root down so the remaining active values again obey the heap rule." },
    ],
    practice: [
      { prompt: "Move the largest value, 4, to the heap root on the left.", start: [3, 1, 4, 2], target: [4, 3, 1, 2], hint: "A max heap must expose its largest active value first." },
      { prompt: "Extract 4 to the sorted right edge.", start: [4, 3, 1, 2], target: [3, 1, 2, 4], hint: "The right edge is outside the active heap once a value is extracted." },
      { prompt: "Restore the max-heap order among the remaining three values.", start: [3, 1, 2, 4], target: [3, 2, 1, 4], hint: "The root stays largest, then its children follow." },
    ],
  },
  quick: {
    label: "Quick sort",
    number: "05",
    heroCopy: "Choose a pivot, split smaller and larger values around it, then repeat on each side.",
    controlTitle: "Partition around a pivot",
    stageLabel: "partition",
    stageDescription: "pivot placement",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Put pivots in their final places.",
    learnCopy: [
      "Quick sort chooses one value as a pivot. It scans the active range and moves values smaller than the pivot to its left, while values larger than the pivot end up on its right.",
      "When the scan is finished, the pivot is placed between those two groups. It is now in its final sorted position: nothing on the left can be larger, and nothing on the right can be smaller. Quick sort repeats the same idea independently on the two smaller ranges.",
    ],
    complexity: ["AVERAGE O(n log n)", "WORST O(n²)", "SPACE O(log n)"],
    cardTitle: "QUICK SORT",
    cardTag: "in-place · pivot-based",
    steps: [
      "Choose the rightmost value as the pivot.",
      "Move smaller values to the pivot's left side.",
      "Place the pivot, then partition each remaining side.",
    ],
    examples: [
      { values: "[4, 1, 3 | 2]", detail: "Use 2 as the pivot; the vertical bar marks the value that will end in its final place." },
      { values: "[1 | 4, 3 | 2]", detail: "Only 1 is smaller than 2, so it belongs on the pivot's left." },
      { values: "[1, 2 | 3, 4]", detail: "Place the pivot, then sort the left and right ranges separately." },
    ],
    practice: [
      { prompt: "Place the value smaller than pivot 2 on its left side.", start: [4, 1, 3, 2], target: [1, 4, 3, 2], hint: "Only 1 is smaller than the pivot." },
      { prompt: "Put pivot 2 between the smaller and larger groups.", start: [1, 4, 3, 2], target: [1, 2, 4, 3], hint: "Everything left of 2 must be smaller; everything right must be larger." },
      { prompt: "Finish the tiny right-side range.", start: [1, 2, 4, 3], target: [1, 2, 3, 4], hint: "Quick sort now works on the range to the pivot's right." },
    ],
  },
  merge: {
    label: "Merge sort",
    number: "06",
    heroCopy: "Build larger ordered runs by repeatedly merging pairs of smaller ordered runs.",
    controlTitle: "Merge ordered runs",
    stageLabel: "merge pass",
    stageDescription: "run merging",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Combine sorted pieces.",
    learnCopy: [
      "Merge sort begins with a useful fact: a single value is already sorted. It repeatedly joins neighboring sorted runs into longer sorted runs, doubling the run size each pass.",
      "To merge two runs, compare their front values and write the smaller front value into a temporary output. Continue until one run is empty, then copy the remaining values from the other run. Because both inputs were sorted, each choice is safe and the combined run is sorted too.",
    ],
    complexity: ["TIME O(n log n)", "STABLE YES", "SPACE O(n)"],
    cardTitle: "MERGE SORT",
    cardTag: "stable · divide and conquer",
    steps: [
      "Start with one-value ordered runs.",
      "Compare the front values of two neighboring runs.",
      "Write the smaller one into a larger merged run.",
    ],
    examples: [
      { values: "[4] [1] [3] [2]", detail: "Each one-value run is already ordered, even though the whole row is not." },
      { values: "[4] + [1] → [1, 4]", detail: "Compare 4 and 1; write the smaller front value first, then copy what remains." },
      { values: "[1, 4] + [2, 3] → [1, 2, 3, 4]", detail: "Merge the two sorted pairs by repeatedly taking the smaller front value." },
    ],
    practice: [
      { prompt: "Merge the first two one-value runs into sorted order.", start: [4, 1, 3, 2], target: [1, 4, 3, 2], hint: "The smaller front value is written first." },
      { prompt: "Merge the second pair into sorted order.", start: [1, 4, 3, 2], target: [1, 4, 2, 3], hint: "Keep each two-value run ordered before the final merge." },
      { prompt: "Merge the two sorted pairs into one ordered row.", start: [1, 4, 2, 3], target: [1, 2, 3, 4], hint: "Compare the front values of the two runs every time." },
    ],
  },
  bogo: {
    label: "Bogo sort",
    number: "07",
    heroCopy: "Shuffle the whole row and hope it lands in order—a deliberately impractical sorting experiment.",
    controlTitle: "Shuffle and hope",
    stageLabel: "shuffle",
    stageDescription: "random attempt",
    eyebrow: "CHAOS EXPERIMENT",
    learnTitle: "Let chance do the sorting.",
    learnCopy: [
      "Bogo sort has no strategy for improving the row. It checks whether the row is sorted; if the answer is no, it produces a completely random new order and checks again.",
      "For n values there are n! possible orders, but only one is fully sorted. That means its odds collapse extremely quickly as n grows. The shuffle cap is not a shortcut to make Bogo practical—it simply stops the experiment before it can run forever.",
    ],
    complexity: ["BEST O(n)", "EXPECTED O(n · n!)", "LIMIT YOU SET"],
    cardTitle: "BOGO SORT",
    cardTag: "randomized · capped demo",
    steps: [
      "Check whether the entire row is ordered.",
      "Shuffle every value when it is not.",
      "Repeat until it works—or the safety limit stops it.",
    ],
    examples: [
      { values: "[3, 1, 2]", detail: "Check adjacent values: 3 > 1, so this attempt has failed." },
      { values: "shuffle → [2, 3, 1]", detail: "A new random order is not guided by any comparison or rule." },
      { values: "lucky shuffle → [1, 2, 3]", detail: "Only by chance does one attempt land on the sorted permutation." },
    ],
    practice: [
      { prompt: "For this tiny example, arrange the lucky sorted shuffle.", start: [3, 1, 2], target: [1, 2, 3], hint: "Bogo has no smarter move—you are just modeling the lucky outcome." },
      { prompt: "Try a second tiny lucky outcome with four values.", start: [2, 4, 1, 3], target: [1, 2, 3, 4], hint: "There is only one successful order among all possible shuffles." },
    ],
  },
  "mean-partition": {
    label: "Mean partition sort",
    number: "08",
    heroCopy: "Split the newly arranged row into 2, 4, 8, and more balanced groups, then rank every group by its average.",
    controlTitle: "Rank groups by their mean",
    stageLabel: "round",
    stageDescription: "mean grouping",
    eyebrow: "EXPERIMENTAL IDEA",
    learnTitle: "Sort blocks before sorting values.",
    learnCopy: [
      "Mean partition sort repeatedly cuts the current row into balanced groups: first 2 groups, then 4, then 8, and so on. It computes each group’s arithmetic mean—the sum divided by the number of values—and moves whole groups so lower means are left of higher means.",
      "A low group mean is only a clue, not proof that every value in that group belongs before every value in another group. That is why the process keeps splitting. Once every group contains one value, its mean is the value itself, so arranging the group means is guaranteed to arrange the row.",
    ],
    complexity: ["ROUNDS O(log n)", "RANKING O(n²) WORST", "SPACE O(n)"],
    cardTitle: "MEAN PARTITION SORT",
    cardTag: "experimental · group-based",
    steps: [
      "Split the current row into 2, 4, 8… balanced groups.",
      "Calculate the average of every group.",
      "Rank all groups from the smallest mean to the largest.",
      "At singleton groups, each mean is the value itself.",
    ],
    examples: [
      { values: "[1, 100] μ=50.5 | [49, 50] μ=49.5", detail: "The second group has the lower average, even though 100 is still inside the first group." },
      { values: "[49, 50 | 1, 100]", detail: "Rank the whole groups by mean: 49.5 goes left of 50.5." },
      { values: "[1] [49] [50] [100]", detail: "After splitting into singleton groups, each displayed mean equals that one value." },
      { values: "[1, 49, 50, 100]", detail: "Ranking those singleton groups is exactly a normal numeric sort." },
    ],
    practice: [
      {
        kind: "partitions",
        prompt: "Drag the lower-mean partition to the left of the higher-mean partition.",
        partitions: [
          { id: "high", values: [1, 100], mean: 50.5 },
          { id: "low", values: [49, 50], mean: 49.5 },
        ],
        targetOrder: ["low", "high"],
        hint: "49.5 is lower than 50.5, so its whole group ranks first." },
      {
        kind: "partitions",
        prompt: "Now the groups are single values. Rank their displayed means from low to high.",
        partitions: [
          { id: "forty-nine", values: [49], mean: 49 },
          { id: "fifty", values: [50], mean: 50 },
          { id: "one", values: [1], mean: 1 },
          { id: "hundred", values: [100], mean: 100 },
        ],
        targetOrder: ["one", "forty-nine", "fifty", "hundred"],
        hint: "For a singleton group, μ is just the number written on the block." },
    ],
  },
};

function createInitialStep(
  values: number[],
  algorithm: AlgorithmId = "insertion",
): SortStep {
  return {
    values: [...values],
    pass: 0,
    phase: "ready",
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: algorithm === "insertion" && values.length ? 1 : 0,
    comparisons: 0,
    writes: 0,
    message:
      values.length <= 1
        ? "One value is already ordered."
        : ALGORITHM_DETAILS[algorithm].heroCopy,
  };
}

function makeRandomArray(length: number) {
  const values = Array.from({ length }, (_, index) => index + 1);

  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }

  return values;
}

function makeBenchmarkArray(length: number, pattern: BenchmarkPattern) {
  const values = Array.from({ length }, (_, index) => index + 1);

  if (pattern === "reverse") {
    return values.reverse();
  }

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

function formatCount(value: number) {
  return value.toLocaleString("en-US");
}

function getWorkEstimate(metrics: {
  comparisons: number;
  rankComparisons: number;
  writes: number;
  meanComputationOperations?: number;
}) {
  return (
    metrics.comparisons +
    metrics.rankComparisons +
    metrics.writes +
    (metrics.meanComputationOperations ?? 0)
  );
}

function buildInsertionSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source)];
  const values = [...source];
  let comparisons = 0;
  let writes = 0;
  const useCompactFrames = values.length > DEFAULT_ARRAY_SIZE;

  for (let i = 1; i < values.length; i += 1) {
    const key = values[i];
    let j = i - 1;

    steps.push({
      values: [...values],
      pass: i,
      phase: "select",
      key,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: i,
      comparisons,
      writes,
      message: "Pass " + i + ": select " + key + " as the key.",
    });

    while (j >= 0) {
      comparisons += 1;
      if (!useCompactFrames) {
        steps.push({
          values: [...values],
          pass: i,
          phase: "compare",
          key,
          comparing: j,
          shifting: null,
          inserting: null,
          gapIndex: null,
          sortedCount: i,
          comparisons,
          writes,
          message: "Compare " + key + " with " + values[j] + ".",
        });
      }

      if (values[j] <= key) break;

      values[j + 1] = values[j];
      writes += 1;
      if (!useCompactFrames) {
        steps.push({
          values: [...values],
          pass: i,
          phase: "shift",
          key,
          comparing: j,
          shifting: j + 1,
          inserting: null,
          gapIndex: j,
          sortedCount: i,
          comparisons,
          writes,
          message: values[j] + " shifts right to make room for " + key + ".",
        });
      }

      j -= 1;
    }

    values[j + 1] = key;
    writes += 1;
    steps.push({
      values: [...values],
      pass: i,
      phase: "insert",
      key,
      comparing: null,
      shifting: null,
      inserting: j + 1,
      gapIndex: null,
      sortedCount: i + 1,
      comparisons,
      writes,
      message: "Insert " + key + " into position " + (j + 1) + ".",
    });
  }

  steps.push({
    values: [...values],
    pass: Math.max(values.length - 1, 0),
    phase: "complete",
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: values.length,
    comparisons,
    writes,
    message: "Every value has found its place.",
  });

  return steps;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

function getBarClass(
  index: number,
  step: SortStep,
  algorithm: AlgorithmId,
) {
  if (algorithm === "mean-partition") {
    if (step.phase === "complete") return "bar--sorted";
    if (step.phase === "split") return "bar--partition";
    if (step.phase === "average") return "bar--mean";
    if (step.phase === "reorder") return "bar--rank";
    return "bar--idle";
  }

  if (algorithm === "bogo") {
    if (step.phase === "complete") return "bar--sorted";
    if (step.phase === "limited") return "bar--limited";
    if (step.phase === "shuffle") return "bar--shuffle";
    return "bar--idle";
  }

  if (algorithm === "quick") {
    if (step.phase === "complete" || step.settled?.includes(index)) return "bar--sorted";
    if (step.phase === "select" && index === step.inserting) return "bar--key";
    if (step.phase === "swap" && (index === step.comparing || index === step.shifting)) {
      return "bar--swap";
    }
    if (index === step.comparing) return "bar--compare";
    if (index === step.shifting) return "bar--shift";
    if (index === step.inserting) return "bar--insert";
    return "bar--idle";
  }

  if (algorithm === "merge") {
    if (step.phase === "complete") return "bar--sorted";
    if (index === step.comparing || index === step.shifting) return "bar--compare";
    if (index === step.inserting) return "bar--insert";
    if (
      step.phase === "merge" &&
      step.rangeStart !== undefined &&
      step.rangeEnd !== undefined &&
      index >= step.rangeStart &&
      index < step.rangeEnd
    ) {
      return "bar--merge";
    }
    return "bar--idle";
  }

  if (algorithm === "cocktail") {
    if (step.phase === "complete" || step.settled?.includes(index)) return "bar--sorted";
    if (
      (step.phase === "swap" || step.phase === "sweep") &&
      (index === step.comparing || index === step.shifting)
    ) {
      return "bar--swap";
    }
    if (index === step.comparing || index === step.shifting) return "bar--compare";
    if (index === step.inserting) return "bar--insert";
    return "bar--idle";
  }

  if (algorithm === "selection") {
    if (step.phase === "complete" || step.settled?.includes(index)) return "bar--sorted";
    if (step.phase === "swap" && (index === step.comparing || index === step.shifting)) {
      return "bar--swap";
    }
    if (index === step.comparing || index === step.shifting) return "bar--compare";
    if (index === step.inserting) return "bar--key";
    return "bar--idle";
  }

  if (algorithm === "heap") {
    if (step.phase === "complete" || step.settled?.includes(index)) return "bar--sorted";
    if (step.phase === "heapify" && (index === step.comparing || index === step.shifting)) {
      return "bar--heap";
    }
    if (step.phase === "swap" && (index === step.comparing || index === step.shifting)) {
      return "bar--swap";
    }
    if (index === step.inserting) return "bar--key";
    if (index === step.comparing || index === step.shifting) return "bar--compare";
    return "bar--idle";
  }

  if (index === step.gapIndex) return "bar--gap";
  if (index === step.inserting) return "bar--insert";
  if (index === step.shifting) return "bar--shift";
  if (index === step.comparing) return "bar--compare";
  if (step.phase === "select" && index === step.pass) return "bar--key";
  if (step.phase === "complete" || index < step.sortedCount) return "bar--sorted";
  return "bar--idle";
}

function getPhaseLabel(phase: StepPhase) {
  const labels: Record<StepPhase, string> = {
    ready: "Ready",
    select: "Select key",
    compare: "Compare",
    shift: "Shift right",
    insert: "Insert key",
    split: "Split groups",
    average: "Measure means",
    reorder: "Rank groups",
    swap: "Swap values",
    sweep: "Sweep",
    heapify: "Restore heap",
    merge: "Merge runs",
    shuffle: "Shuffle",
    limited: "Safety stop",
    complete: "Sorted",
  };

  return labels[phase];
}

export default function Home() {
  const [algorithm, setAlgorithm] = useState<AlgorithmId>("insertion");
  const [arraySize, setArraySize] = useState(DEFAULT_ARRAY_SIZE);
  const [arraySizeInput, setArraySizeInput] = useState(String(DEFAULT_ARRAY_SIZE));
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [speedInput, setSpeedInput] = useState(String(DEFAULT_SPEED));
  const [bogoAttemptLimit, setBogoAttemptLimit] = useState(BOGO_MAX_ATTEMPTS);
  const [benchmarkPattern, setBenchmarkPattern] =
    useState<BenchmarkPattern>("random");
  const [originalValues, setOriginalValues] = useState(INITIAL_VALUES);
  const [values, setValues] = useState(INITIAL_VALUES);
  const [steps, setSteps] = useState<SortStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [runState, setRunState] = useState<RunState>("ready");
  const [bogoLiveStep, setBogoLiveStep] = useState<SortStep | null>(null);
  const [bogoCelebration, setBogoCelebration] = useState(false);
  const [soundVolume, setSoundVolume] = useState(50);
  const [practiceStepIndex, setPracticeStepIndex] = useState(0);
  const [practiceValues, setPracticeValues] = useState([5, 3, 4, 1]);
  const [practicePartitionOrder, setPracticePartitionOrder] = useState<string[]>([]);
  const [practiceSelectedIndex, setPracticeSelectedIndex] = useState<number | null>(null);
  const [practiceDragIndex, setPracticeDragIndex] = useState<number | null>(null);
  const [practiceSolved, setPracticeSolved] = useState(false);
  const [practiceFeedback, setPracticeFeedback] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastToneTimeRef = useRef(0);
  const meanBarElementsRef = useRef(new Map<number, HTMLDivElement>());
  const meanBarPositionsRef = useRef(new Map<number, number>());
  const bogoSessionRef = useRef<BogoSession | null>(null);
  const [meanSlideOffsets, setMeanSlideOffsets] = useState<Record<number, number>>({});
  const [meanSlideStage, setMeanSlideStage] = useState<"idle" | "prepare" | "animate">("idle");
  const prefersReducedMotion = usePrefersReducedMotion();
  const isMeanPartition = algorithm === "mean-partition";
  const isBogo = algorithm === "bogo";
  const bogoAttemptMaximum = getBogoAttemptMaximum(arraySize);
  const bogoSliderStep = 1;
  const soundEnabled = soundVolume > 0;
  const algorithmDetails = ALGORITHM_DETAILS[algorithm];
  const practiceSteps = algorithmDetails.practice;
  const practiceFinished = practiceStepIndex >= practiceSteps.length;
  const currentPractice = practiceSteps[Math.min(practiceStepIndex, practiceSteps.length - 1)];
  const isPartitionPractice = currentPractice.kind === "partitions";
  const algorithmLabel = algorithmDetails.label;
  const stageLabel = algorithmDetails.stageLabel;
  const totalStages = isMeanPartition
    ? Math.max(1, Math.ceil(Math.log2(Math.max(originalValues.length, 1))))
    : isBogo
      ? bogoAttemptLimit
      : algorithm === "merge"
        ? Math.max(1, Math.ceil(Math.log2(Math.max(originalValues.length, 1))))
        : algorithm === "heap"
          ? Math.max(1, originalValues.length)
        : Math.max(originalValues.length - 1, 0);
  const minimumArraySize = 4;
  const maximumArraySize = 256;
  const benchmarkData = useMemo(
    () =>
      BENCHMARK_SIZES.map((size) => {
        const benchmarkValues = makeBenchmarkArray(size, benchmarkPattern);
        const insertion = analyzeInsertionSort(benchmarkValues);
        const cocktail = analyzeCocktailSort(benchmarkValues);
        const selection = analyzeSelectionSort(benchmarkValues);
        const heap = analyzeHeapSort(benchmarkValues);
        const quick = analyzeQuickSort(benchmarkValues);
        const merge = analyzeMergeSort(benchmarkValues);
        const meanPartition = analyzeMeanPartitionSort(benchmarkValues);

        return {
          size,
          work: {
            insertion: getWorkEstimate(insertion),
            cocktail: getWorkEstimate(cocktail),
            selection: getWorkEstimate(selection),
            heap: getWorkEstimate(heap),
            quick: getWorkEstimate(quick),
            merge: getWorkEstimate(merge),
            meanPartition: getWorkEstimate(meanPartition),
          } satisfies BenchmarkWork,
        };
      }),
    [benchmarkPattern],
  );
  const benchmarkMaximum = Math.max(
    1,
    ...benchmarkData.flatMap((entry) => Object.values(entry.work)),
  );
  const selectedBenchmark = useMemo(() => {
    const benchmarkValues = makeBenchmarkArray(arraySize, benchmarkPattern);
    const insertion = analyzeInsertionSort(benchmarkValues);
    const cocktail = analyzeCocktailSort(benchmarkValues);
    const selection = analyzeSelectionSort(benchmarkValues);
    const heap = analyzeHeapSort(benchmarkValues);
    const quick = analyzeQuickSort(benchmarkValues);
    const merge = analyzeMergeSort(benchmarkValues);
    const meanPartition = analyzeMeanPartitionSort(benchmarkValues);

    return {
      insertion: getWorkEstimate(insertion),
      cocktail: getWorkEstimate(cocktail),
      selection: getWorkEstimate(selection),
      heap: getWorkEstimate(heap),
      quick: getWorkEstimate(quick),
      merge: getWorkEstimate(merge),
      meanPartition: getWorkEstimate(meanPartition),
    } satisfies BenchmarkWork;
  }, [arraySize, benchmarkPattern]);
  const selectedBenchmarkMaximum = Math.max(
    1,
    ...Object.values(selectedBenchmark),
  );

  const currentStep = useMemo(
    () =>
      isBogo && bogoLiveStep
        ? bogoLiveStep
        : steps[stepIndex] ?? createInitialStep(values, algorithm),
    [algorithm, bogoLiveStep, isBogo, stepIndex, steps, values],
  );
  const visibleValues = currentStep.values;
  const mergePassFrameCounts = useMemo(() => {
    if (algorithm !== "merge") return new Map<number, number>();

    return steps.reduce((counts, step) => {
      if (step.pass > 0 && step.phase !== "complete") {
        counts.set(step.pass, (counts.get(step.pass) ?? 0) + 1);
      }
      return counts;
    }, new Map<number, number>());
  }, [algorithm, steps]);

  useEffect(() => {
    if (!isBogo || runState !== "complete" || currentStep.phase !== "complete") {
      return;
    }

    if (soundEnabled) playBogoVictorySound();
    setBogoCelebration(true);
    const timer = window.setTimeout(() => setBogoCelebration(false), 4800);
    return () => window.clearTimeout(timer);
  }, [currentStep.phase, isBogo, runState]);

  useLayoutEffect(() => {
    const captureMeanBarPositions = () => {
      const positions = new Map<number, number>();

      visibleValues.forEach((value) => {
        const bar = meanBarElementsRef.current.get(value);
        if (bar) positions.set(value, bar.getBoundingClientRect().left);
      });

      return positions;
    };

    if (!isMeanPartition || prefersReducedMotion) {
      meanBarPositionsRef.current = captureMeanBarPositions();
      setMeanSlideOffsets({});
      setMeanSlideStage("idle");
      return;
    }

    const nextPositions = captureMeanBarPositions();
    if (currentStep.phase !== "reorder") {
      meanBarPositionsRef.current = nextPositions;
      return;
    }

    const offsets: Record<number, number> = {};
    let hasMovement = false;

    nextPositions.forEach((nextLeft, value) => {
      const previousLeft = meanBarPositionsRef.current.get(value);
      if (previousLeft === undefined) return;

      const offset = previousLeft - nextLeft;
      if (Math.abs(offset) < 1) return;
      offsets[value] = offset;
      hasMovement = true;
    });

    meanBarPositionsRef.current = nextPositions;
    if (!hasMovement) return;

    setMeanSlideOffsets(offsets);
    setMeanSlideStage("prepare");

    let settleFrame: number | undefined;
    let releaseTimer: number | undefined;
    const startFrame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        setMeanSlideOffsets({});
        setMeanSlideStage("animate");
        releaseTimer = window.setTimeout(() => setMeanSlideStage("idle"), meanSlideDuration);
      });
    });

    return () => {
      window.cancelAnimationFrame(startFrame);
      if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame);
      if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
    };
  }, [currentStep.pass, currentStep.phase, isMeanPartition, prefersReducedMotion, visibleValues]);

  const isLocked = runState === "running" || runState === "paused";
  const isLargeArray = originalValues.length > DEFAULT_ARRAY_SIZE;
  const playbackDensity = isBogo ? 48 : 1;
  const speedDelay = 720 - speed * 7.13;
  const meanSlideDuration = Math.round(Math.max(520, 1_050 - speed * 5.3));
  const meanStaticDelay = Math.max(190, 620 - speed * 4);
  const minimumFrameDelay = isLargeArray && !isBogo ? 16 : 7;
  const usesEvenMergePacing =
    algorithm === "merge" &&
    currentStep.phase !== "ready" &&
    currentStep.phase !== "complete";
  const mergePassDuration = Math.max(600, 3_400 - speed * 28);
  const mergeFramesInCurrentPass = mergePassFrameCounts.get(currentStep.pass) ?? 1;
  const delay = prefersReducedMotion
    ? 18
    : isMeanPartition
      ? currentStep.phase === "reorder"
        ? meanSlideDuration + 120
        : meanStaticDelay
      : usesEvenMergePacing
      ? Math.max(minimumFrameDelay, mergePassDuration / mergeFramesInCurrentPass)
      : Math.max(minimumFrameDelay, speedDelay / playbackDensity);
  const shouldInterpolateDenseBars =
    isLargeArray && !isBogo && !prefersReducedMotion && speed <= 50;
  const denseBarTransitionStyle = shouldInterpolateDenseBars
    ? ({
        "--bar-transition-duration": String(Math.min(260, Math.max(90, delay * 0.75))) + "ms",
      } as CSSProperties)
    : undefined;
  const meanTransitionStyle = isMeanPartition
    ? ({ "--mean-slide-duration": String(meanSlideDuration) + "ms" } as CSSProperties)
    : undefined;
  const barTransitionStyle = isMeanPartition
    ? ({
        ...(denseBarTransitionStyle ?? {}),
        "--mean-slide-duration": String(meanSlideDuration) + "ms",
      } as CSSProperties)
    : denseBarTransitionStyle;
  const progress =
    runState === "complete"
      ? 100
      : isBogo
        ? Math.round((currentStep.pass / Math.max(bogoAttemptLimit, 1)) * 100)
      : steps.length > 1
        ? Math.round((stepIndex / (steps.length - 1)) * 100)
        : 0;
  const displayValues = visibleValues.join(", ");
  const largestValue = Math.max(...originalValues, 1);
  const liveStatus =
    currentStep.phase === "limited"
      ? "Bogo Sort stopped after the shuffle safety limit. Try a new array or another algorithm."
      : runState === "complete"
        ? isMeanPartition
          ? "Sorting complete. " + currentStep.comparisons + " group means and " + currentStep.writes + " moved values."
          : "Sorting complete. " + currentStep.comparisons + " comparisons and " + currentStep.writes + " array writes."
      : runState === "paused"
        ? "Paused during " + stageLabel + " " + currentStep.pass + " of " + totalStages + "."
        : runState === "running"
          ? algorithmLabel + " is working through " + stageLabel + " " + currentStep.pass + " of " + totalStages + "."
          : "Ready to demonstrate " + algorithmLabel + ".";

  function ensureAudioContext() {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    if (audioContextRef.current.state === "suspended") {
      void audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }

  function playSortingTone(step: SortStep) {
    const context = audioContextRef.current;
    if (!context || context.state !== "running" || step.values.length === 0) return;

    const now = context.currentTime;
    const cooldown = isBogo ? 0.12 : isLargeArray ? 0.045 : 0.028;
    if (now - lastToneTimeRef.current < cooldown) return;
    lastToneTimeRef.current = now;

    const activeIndex = Math.min(
      step.values.length - 1,
      Math.max(0, step.inserting ?? step.comparing ?? step.shifting ?? 0),
    );
    const activeValue = step.values[activeIndex] ?? step.key ?? 1;
    const normalizedValue = Math.min(1, Math.max(0, activeValue / largestValue));
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const duration = step.phase === "swap" || step.phase === "merge" ? 0.05 : 0.032;
    const basePeakGain = step.phase === "swap" ? 0.2 : 0.14;
    const peakGain = basePeakGain * (soundVolume / 100) ** 2.5;

    oscillator.type = step.phase === "swap" || step.phase === "shift" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(180 + normalizedValue * 700, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.01);
  }

  function playBogoVictorySound() {
    const context = audioContextRef.current;
    if (!context || context.state !== "running" || soundVolume <= 0) return;

    const now = context.currentTime;
    const notes = [523.25, 659.25, 783.99, 1_046.5];

    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startTime = now + index * 0.1;
      const duration = index === notes.length - 1 ? 0.38 : 0.14;
      const peakGain = 0.16 * (soundVolume / 100) ** 2.5;

      oscillator.type = index === notes.length - 1 ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequency, startTime);
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startTime);
      oscillator.stop(startTime + duration + 0.02);
    });
  }

  useEffect(() => {
    return () => {
      void audioContextRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (
      !soundEnabled ||
      runState !== "running" ||
      stepIndex === 0 ||
      !AUDIBLE_PHASES.includes(currentStep.phase)
    ) {
      return;
    }

    playSortingTone(currentStep);
  }, [currentStep, runState, soundEnabled, stepIndex]);

  useEffect(() => {
    if (!isBogo || runState !== "running") return;

    const session = bogoSessionRef.current;
    if (!session) return;

    let cancelled = false;
    let timer: number | undefined;

    const runBatch = () => {
      if (cancelled || bogoSessionRef.current !== session) return;

      const deadline = performance.now() + 8;
      do {
        advanceBogoSession(session);
      } while (!session.done && performance.now() < deadline);

      setBogoLiveStep(getBogoSessionStep(session));
      if (session.done) {
        setRunState("complete");
        return;
      }

      timer = window.setTimeout(runBatch, 0);
    };

    timer = window.setTimeout(runBatch, 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isBogo, runState]);

  useEffect(() => {
    if (isBogo || runState !== "running" || steps.length === 0) return;

    const timer = window.setTimeout(() => {
      const nextIndex = stepIndex + 1;
      if (nextIndex >= steps.length) {
        setRunState("complete");
        return;
      }

      setStepIndex(nextIndex);
      if (nextIndex === steps.length - 1) {
        setRunState("complete");
      }
    }, delay);

    return () => window.clearTimeout(timer);
  }, [delay, isBogo, runState, stepIndex, steps]);

  function createNewArray(size = arraySize) {
    const nextValues = makeRandomArray(size);
    setBogoCelebration(false);
    bogoSessionRef.current = null;
    setBogoLiveStep(null);
    setOriginalValues(nextValues);
    setValues(nextValues);
    setSteps([]);
    setStepIndex(0);
    setRunState("ready");
  }

  function resetArray() {
    setBogoCelebration(false);
    bogoSessionRef.current = null;
    setBogoLiveStep(null);
    setValues([...originalValues]);
    setSteps([]);
    setStepIndex(0);
    setRunState("ready");
  }

  function handleSoundVolumeChange(nextVolume: number) {
    if (nextVolume > 0 && soundVolume === 0) ensureAudioContext();
    setSoundVolume(nextVolume);
  }

  function setMeanBarRef(value: number, element: HTMLDivElement | null) {
    if (element) meanBarElementsRef.current.set(value, element);
  }

  function resetPractice(nextAlgorithm = algorithm) {
    const firstStep = ALGORITHM_DETAILS[nextAlgorithm].practice[0];
    setPracticeStepIndex(0);
    setPracticeSelectedIndex(null);
    setPracticeDragIndex(null);
    setPracticeSolved(false);
    setPracticeFeedback(null);

    if (firstStep.kind === "partitions") {
      setPracticeValues([]);
      setPracticePartitionOrder(firstStep.partitions.map((partition) => partition.id));
      return;
    }

    setPracticeValues([...firstStep.start]);
    setPracticePartitionOrder([]);
  }

  function movePracticeItem(fromIndex: number, toIndex: number) {
    if (practiceFinished || fromIndex === toIndex) return;

    if (isPartitionPractice) {
      setPracticePartitionOrder((currentOrder) => {
        const nextOrder = [...currentOrder];
        const [moved] = nextOrder.splice(fromIndex, 1);
        nextOrder.splice(toIndex, 0, moved);
        return nextOrder;
      });
    } else {
      setPracticeValues((currentValues) => {
        const nextValues = [...currentValues];
        const [moved] = nextValues.splice(fromIndex, 1);
        nextValues.splice(toIndex, 0, moved);
        return nextValues;
      });
    }

    setPracticeSelectedIndex(null);
    setPracticeSolved(false);
    setPracticeFeedback(null);
  }

  function handlePracticeBlockClick(index: number) {
    if (practiceFinished) return;
    if (practiceSelectedIndex === null) {
      setPracticeSelectedIndex(index);
      return;
    }

    if (practiceSelectedIndex === index) {
      setPracticeSelectedIndex(null);
      return;
    }

    movePracticeItem(practiceSelectedIndex, index);
  }

  function checkPracticeStep() {
    const isCorrect = isPartitionPractice
      ? currentPractice.targetOrder.every(
          (partitionId, index) => practicePartitionOrder[index] === partitionId,
        )
      : currentPractice.target.every((value, index) => practiceValues[index] === value);

    if (isCorrect) {
      setPracticeSolved(true);
      setPracticeFeedback(
        practiceStepIndex === practiceSteps.length - 1
          ? "Correct—this completes the walkthrough."
          : "Correct. You followed the rule for this step; continue to the next one.",
      );
      return;
    }

    setPracticeSolved(false);
    setPracticeFeedback("Not quite. Hint: " + currentPractice.hint);
  }

  function advancePracticeStep() {
    const nextStepIndex = practiceStepIndex + 1;
    if (nextStepIndex >= practiceSteps.length) {
      setPracticeStepIndex(practiceSteps.length);
      setPracticeSelectedIndex(null);
      setPracticeDragIndex(null);
      setPracticeSolved(false);
      return;
    }

    const nextStep = practiceSteps[nextStepIndex];
    setPracticeStepIndex(nextStepIndex);
    setPracticeSelectedIndex(null);
    setPracticeDragIndex(null);
    setPracticeSolved(false);
    setPracticeFeedback(null);

    if (nextStep.kind === "partitions") {
      setPracticeValues([]);
      setPracticePartitionOrder(nextStep.partitions.map((partition) => partition.id));
      return;
    }

    setPracticeValues([...nextStep.start]);
    setPracticePartitionOrder([]);
  }

  function handleAlgorithmChange(nextAlgorithm: AlgorithmId) {
    setBogoCelebration(false);
    bogoSessionRef.current = null;
    setBogoLiveStep(null);
    setAlgorithm(nextAlgorithm);
    setValues([...originalValues]);
    setSteps([]);
    setStepIndex(0);
    setRunState("ready");
    resetPractice(nextAlgorithm);
  }

  function handlePrimaryAction() {
    if (runState === "running") {
      setRunState("paused");
      return;
    }

    if (runState === "paused") {
      setRunState("running");
      return;
    }

    if (soundEnabled) ensureAudioContext();
    setBogoCelebration(false);
    if (algorithm === "bogo") {
      const session = createBogoSession(originalValues, bogoAttemptLimit);
      bogoSessionRef.current = session;
      setValues([...originalValues]);
      setSteps([]);
      setStepIndex(0);
      setBogoLiveStep(session.done ? getBogoSessionStep(session) : null);
      setRunState(session.done ? "complete" : "running");
      return;
    }

    bogoSessionRef.current = null;
    setBogoLiveStep(null);
    const sequence =
      algorithm === "mean-partition"
        ? buildMeanPartitionSteps(originalValues)
        : algorithm === "cocktail"
          ? buildCocktailSteps(originalValues)
          : algorithm === "selection"
            ? buildSelectionSteps(originalValues)
            : algorithm === "heap"
              ? buildHeapSortSteps(originalValues)
              : algorithm === "quick"
                ? buildQuickSortSteps(originalValues)
                : algorithm === "merge"
                  ? buildMergeSortSteps(originalValues)
                  : buildInsertionSteps(originalValues);
    setValues([...originalValues]);
    setSteps(sequence);
    setStepIndex(0);
    setRunState(sequence.length > 1 ? "running" : "complete");
  }

  function handleArraySizeChange(nextSize: number) {
    const clampedSize = Math.min(maximumArraySize, Math.max(minimumArraySize, Math.round(nextSize)));
    const nextBogoAttemptMaximum = getBogoAttemptMaximum(clampedSize);
    if (bogoAttemptLimit > nextBogoAttemptMaximum) {
      setBogoAttemptLimit(nextBogoAttemptMaximum);
    }
    setArraySize(clampedSize);
    setArraySizeInput(String(clampedSize));
    createNewArray(clampedSize);
  }

  function handleArraySizeInputChange(input: string) {
    setArraySizeInput(input);
  }

  function normalizeArraySizeInput() {
    const candidate = Math.round(Number(arraySizeInput));
    if (!Number.isFinite(candidate)) {
      setArraySizeInput(String(arraySize));
      return;
    }
    const clampedSize = Math.min(maximumArraySize, Math.max(minimumArraySize, candidate));
    if (clampedSize !== arraySize) {
      handleArraySizeChange(clampedSize);
      return;
    }
    setArraySizeInput(String(clampedSize));
  }

  function handleSpeedChange(nextSpeed: number) {
    const clampedSpeed = Math.min(100, Math.max(1, Math.round(nextSpeed)));
    setSpeed(clampedSpeed);
    setSpeedInput(String(clampedSpeed));
  }

  function handleSpeedInputChange(input: string) {
    setSpeedInput(input);
  }

  function normalizeSpeedInput() {
    const candidate = Math.round(Number(speedInput));
    if (!Number.isFinite(candidate)) {
      setSpeedInput(String(speed));
      return;
    }
    handleSpeedChange(candidate);
  }

  function handleBogoAttemptLimitChange(nextLimit: number) {
    const clampedLimit = Math.min(
      bogoAttemptMaximum,
      Math.max(BOGO_MIN_ATTEMPTS, Math.round(nextLimit)),
    );
    setBogoAttemptLimit(clampedLimit);
  }

  const primaryLabel =
    runState === "running"
      ? "Pause"
      : runState === "paused"
        ? "Resume"
        : runState === "complete"
          ? "Replay sort"
          : "Start sorting";

  return (
    <main className="sortlab-app">
      <div className="page-glow page-glow--one" aria-hidden="true" />
      <div className="page-glow page-glow--two" aria-hidden="true" />
      {bogoCelebration && (
        <div
          className={"bogo-celebration " + (prefersReducedMotion ? "bogo-celebration--reduced" : "")}
          role="status"
          aria-live="polite"
        >
          <div className="bogo-confetti" aria-hidden="true">
            {BOGO_CONFETTI.map((piece) => (
              <i
                className={"bogo-confetti__piece bogo-confetti__piece--" + piece.shape}
                key={piece.id}
                style={{
                  left: String(piece.left) + "%",
                  background: piece.color,
                  animationDelay: String(piece.delay) + "s",
                  animationDuration: String(piece.duration) + "s",
                }}
              />
            ))}
          </div>
          <div className="bogo-celebration__message">
            <span>BOGO SORT</span>
            <strong>Holy shit, it actually worked!</strong>
          </div>
        </div>
      )}

      <div className="shell">
        <header className="site-header">
          <a className="brand" href="#visualizer" aria-label="Sortscope visualizer">
            <span className="brand-mark" aria-hidden="true" />
            <span>sortscope</span>
          </a>
          <div className="header-note">
            <span className="header-note__dot" aria-hidden="true" />
            algorithm study tool
          </div>
        </header>

        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">SORTING, MADE VISIBLE</p>
            <h1 id="page-title">
              Watch each value
              <span> find its place.</span>
            </h1>
            <p className="hero-copy">{algorithmDetails.heroCopy}</p>
          </div>
          <div className="hero-aside">
            <span className="hero-aside__number">{algorithmDetails.number}</span>
            <div>
              <p>NOW EXPLORING</p>
              <strong>{algorithmLabel}</strong>
            </div>
          </div>
        </section>

        <section id="visualizer" className="visualizer" aria-labelledby="visualizer-title">
          <div className="control-deck">
            <div className="control-deck__intro">
              <p className="eyebrow">CONTROL ROOM</p>
              <h2 id="visualizer-title">{algorithmDetails.controlTitle}</h2>
            </div>

            <div className="controls" aria-label="Visualizer controls">
              <div className="algorithm-controls">
                <label className="control-field control-field--algorithm">
                  <span className="control-label">Algorithm</span>
                  <select
                    value={algorithm}
                    onChange={(event) => handleAlgorithmChange(event.target.value as AlgorithmId)}
                    disabled={isLocked}
                    aria-label="Sorting algorithm"
                  >
                    <option value="insertion">Insertion sort</option>
                    <option value="cocktail">Cocktail sort</option>
                    <option value="selection">Selection sort</option>
                    <option value="heap">Heap sort</option>
                    <option value="quick">Quick sort</option>
                    <option value="merge">Merge sort</option>
                    <option value="mean-partition">Mean partition sort</option>
                    <option value="bogo">Bogo sort</option>
                  </select>
                </label>

                {isBogo && (
                  <label className="control-field control-field--range bogo-attempt-limit">
                    <span className="control-label">
                      Max shuffles
                      <strong>{bogoAttemptLimit.toLocaleString("en-US")}</strong>
                    </span>
                    <input
                      type="range"
                      min={BOGO_MIN_ATTEMPTS}
                      max={bogoAttemptMaximum}
                      step={bogoSliderStep}
                      value={bogoAttemptLimit}
                      onChange={(event) => handleBogoAttemptLimitChange(Number(event.target.value))}
                      disabled={isLocked}
                      aria-label="Maximum Bogo Sort shuffles"
                    />
                  </label>
                )}
              </div>

              <label className="control-field control-field--range">
                <span className="control-label">
                  Array size
                  <input
                    className="control-number"
                    type="number"
                    min={minimumArraySize}
                    max={maximumArraySize}
                    step="1"
                    value={arraySizeInput}
                    onChange={(event) => handleArraySizeInputChange(event.target.value)}
                    onBlur={normalizeArraySizeInput}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    disabled={isLocked}
                    aria-label="Array size exact value"
                  />
                </span>
                <input
                  type="range"
                  min={minimumArraySize}
                  max={maximumArraySize}
                  step="1"
                  value={arraySize}
                  onChange={(event) => handleArraySizeChange(Number(event.target.value))}
                  disabled={isLocked}
                  aria-label="Array size"
                />
              </label>

              <label className="control-field control-field--range">
                <span className="control-label">
                  Speed
                  {prefersReducedMotion ? (
                    <strong>instant</strong>
                  ) : (
                    <input
                      className="control-number"
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      value={speedInput}
                      onChange={(event) => handleSpeedInputChange(event.target.value)}
                      onBlur={normalizeSpeedInput}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      aria-label="Animation speed exact percent"
                    />
                  )}
                </span>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={speed}
                  onChange={(event) => handleSpeedChange(Number(event.target.value))}
                  aria-label="Animation speed"
                />
              </label>

              <div className="button-row">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => createNewArray()}
                  disabled={isLocked}
                >
                  New array
                </button>
                <button className="button button--primary" type="button" onClick={handlePrimaryAction}>
                  <span className={"button-pulse " + (runState === "running" ? "button-pulse--active" : "")} aria-hidden="true" />
                  {primaryLabel}
                </button>
                <button className="text-button" type="button" onClick={resetArray}>
                  Reset
                </button>
                <label className="control-field sound-volume">
                  <span className="control-label">
                    Sound <strong>{soundVolume}%</strong>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={soundVolume}
                    onChange={(event) => handleSoundVolumeChange(Number(event.target.value))}
                    aria-label="Sorting sound volume"
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="workbench">
            <div className="workbench__topline">
              <div>
                <p className="workbench__overline">LIVE ARRAY</p>
                <p className="workbench__message">{currentStep.message}</p>
              </div>
              <div className={"phase-chip phase-chip--" + currentStep.phase}>
                <span aria-hidden="true" />
                {getPhaseLabel(currentStep.phase)}
              </div>
            </div>

            <div className="chart-stage" role="img" aria-label={"Array values: " + displayValues + ". " + currentStep.message}>
              <div className="chart-grid" aria-hidden="true" />
              {isMeanPartition && currentStep.groups && (
                <div
                  className={"mean-bands mean-bands--" + meanSlideStage}
                  style={meanTransitionStyle}
                  aria-hidden="true"
                >
                  {currentStep.groups.map((group) => {
                    const left = (group.start / Math.max(visibleValues.length, 1)) * 100;
                    const width =
                      ((group.end - group.start) / Math.max(visibleValues.length, 1)) * 100;
                    return (
                      <div
                        className="mean-band"
                        key={String(group.id)}
                        style={{ left: String(left) + "%", width: String(width) + "%" }}
                      >
                        {currentStep.groups && currentStep.groups.length <= 8 && (
                          <span>μ {formatMean(group.mean)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {algorithm === "insertion" && currentStep.phase === "shift" && currentStep.key !== null && (
                <div className="held-key" aria-hidden="true">
                  <span>holding key</span>
                  <strong>{currentStep.key}</strong>
                </div>
              )}
              <div
                className={
                  "bars " +
                  (isLargeArray ? "bars--dense " : "") +
                  (algorithm === "merge" ? "bars--merge " : "") +
                  (isMeanPartition ? "bars--mean bars--mean-" + meanSlideStage + " " : "") +
                  (shouldInterpolateDenseBars ? "bars--smooth" : "")
                }
                style={barTransitionStyle}
                aria-hidden="true"
              >
                {visibleValues.map((value, index) => {
                  const isGap = index === currentStep.gapIndex;
                  const shownValue = isGap && currentStep.key !== null ? currentStep.key : value;
                  const group = isMeanPartition
                    ? currentStep.groups?.find(
                        (candidate) => index >= candidate.start && index < candidate.end,
                      )
                    : undefined;
                  const groupClass = group
                    ? (index === group.start ? "bar-slot--group-start " : "") +
                      (index === group.end - 1 ? "bar-slot--group-end" : "")
                    : "";
                  const height = (shownValue / largestValue) * 100;
                  const meanSlideOffset = isMeanPartition ? meanSlideOffsets[value] : undefined;
                  const meanSlotStyle =
                    meanSlideOffset === undefined
                      ? undefined
                      : ({ transform: "translateX(" + meanSlideOffset + "px)" } as CSSProperties);
                  return (
                    <div
                      className={"bar-slot " + groupClass}
                      key={isMeanPartition ? "mean-" + String(value) : String(index) + "-" + String(originalValues.length)}
                      ref={isMeanPartition ? (element) => setMeanBarRef(value, element) : undefined}
                      style={meanSlotStyle}
                    >
                      <div
                        className={"bar " + getBarClass(index, currentStep, algorithm)}
                        style={{ height: String(height) + "%" }}
                      >
                        {arraySize <= 24 && (
                          <span className="bar__value">{isGap ? "gap" : value}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="axis-labels" aria-hidden="true">
                <span>lower values</span>
                <span>higher values</span>
              </div>
            </div>

            <div className="workbench__footer">
              <div className="legend" aria-label="Color legend">
                {isMeanPartition ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />current row</span>
                    <span><i className="legend__swatch legend__swatch--partition" />split groups</span>
                    <span><i className="legend__swatch legend__swatch--mean" />mean measured</span>
                    <span><i className="legend__swatch legend__swatch--rank" />groups ranked</span>
                  </>
                ) : isBogo ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />not ordered</span>
                    <span><i className="legend__swatch legend__swatch--shuffle" />random shuffle</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />ordered by chance</span>
                  </>
                ) : algorithm === "merge" ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />current runs</span>
                    <span><i className="legend__swatch legend__swatch--compare" />run comparison</span>
                    <span><i className="legend__swatch legend__swatch--merge" />merged write</span>
                  </>
                ) : algorithm === "quick" ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />active range</span>
                    <span><i className="legend__swatch legend__swatch--key" />pivot</span>
                    <span><i className="legend__swatch legend__swatch--swap" />partition swap</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />placed pivot</span>
                  </>
                ) : algorithm === "cocktail" ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />unsorted</span>
                    <span><i className="legend__swatch legend__swatch--compare" />neighbors checked</span>
                    <span><i className="legend__swatch legend__swatch--swap" />swap</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />settled edge</span>
                  </>
                ) : algorithm === "selection" ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />unsorted</span>
                    <span><i className="legend__swatch legend__swatch--key" />next position</span>
                    <span><i className="legend__swatch legend__swatch--compare" />minimum search</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />selected minimum</span>
                  </>
                ) : algorithm === "heap" ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />active heap</span>
                    <span><i className="legend__swatch legend__swatch--key" />heap root</span>
                    <span><i className="legend__swatch legend__swatch--heap" />sifting values</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />extracted value</span>
                  </>
                ) : (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />unsorted</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />sorted prefix</span>
                    <span><i className="legend__swatch legend__swatch--key" />active key</span>
                    <span><i className="legend__swatch legend__swatch--compare" />comparison</span>
                  </>
                )}
              </div>
              <div className="motion-note">
                {prefersReducedMotion ? "Reduced motion is on" : "Adjustable speed"}
              </div>
            </div>
          </div>

          <div className="stats" aria-label="Sort statistics">
            <div className="stat-card">
              <span>{stageLabel.toUpperCase()}</span>
              <strong>{currentStep.pass}<em> / {totalStages}</em></strong>
              <p>{algorithmDetails.stageDescription}</p>
            </div>
            <div className="stat-card">
              <span>{isMeanPartition ? "MEANS READ" : isBogo ? "ORDER CHECKS" : "COMPARISONS"}</span>
              <strong>{currentStep.comparisons}</strong>
              <p>{isMeanPartition ? "group averages" : isBogo ? "values checked" : "values checked"}</p>
            </div>
            <div className="stat-card">
              <span>{isMeanPartition ? "VALUES MOVED" : isBogo ? "SHUFFLE WRITES" : "ARRAY WRITES"}</span>
              <strong>{currentStep.writes}</strong>
              <p>{isMeanPartition ? "re-ranked groups" : isBogo ? "random swaps" : "moves + writes"}</p>
            </div>
            <div className="stat-card stat-card--progress">
              <span>PROGRESS</span>
              <strong>{progress}<em>%</em></strong>
              <div className="progress-track" aria-hidden="true"><i style={{ width: String(progress) + "%" }} /></div>
            </div>
          </div>
        </section>

        <section className="learn-grid" aria-labelledby="learn-title">
          <div className="learn-copy">
            <p className="eyebrow">{algorithmDetails.eyebrow}</p>
            <h2 id="learn-title">{algorithmDetails.learnTitle}</h2>
            <div className="learn-copy__explanation">
              {algorithmDetails.learnCopy.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            <div className="complexity-row" aria-label={algorithmLabel + " characteristics"}>
              {algorithmDetails.complexity.map((item) => {
                const [label, ...detail] = item.split(" ");
                return <span key={item}><b>{label}</b> {detail.join(" ")}</span>;
              })}
            </div>
          </div>

          <div className="algorithm-card">
            <div className="algorithm-card__header">
              <span>{algorithmDetails.cardTitle}</span>
              <span>{algorithmDetails.cardTag}</span>
            </div>
            <ol className="algorithm-steps">
              {algorithmDetails.steps.map((step, index) => {
                const example = algorithmDetails.examples[index];
                return (
                <li key={step}>
                  <i>{String(index + 1).padStart(2, "0")}</i>
                  <div className="algorithm-step__body">
                    <strong>{step}</strong>
                    <code>{example.values}</code>
                    <p>{example.detail}</p>
                  </div>
                </li>
                );
              })}
            </ol>
          </div>

          <div className="practice-lab" aria-labelledby="practice-title">
            <div className="practice-lab__header">
              <div>
                <p className="eyebrow">TRY IT YOURSELF</p>
                <h3 id="practice-title">Move the blocks, then check the rule.</h3>
              </div>
              <span>
                {practiceFinished
                  ? "complete"
                  : "step " + String(practiceStepIndex + 1) + " of " + String(practiceSteps.length)}
              </span>
            </div>
            <p className="practice-lab__prompt">
              {practiceFinished
                ? "You completed this small walkthrough. Restart it any time to practice the moves again."
                : currentPractice.prompt}
            </p>
            <p className="practice-lab__help">
              Drag a block to slide it into a new place, or select one block and then select its destination.
            </p>
            <div className="practice-board" role="group" aria-label={algorithmLabel + " interactive practice blocks"}>
              {isPartitionPractice
                ? practicePartitionOrder.map((partitionId, index) => {
                    const partition = currentPractice.partitions.find(
                      (candidate) => candidate.id === partitionId,
                    );
                    if (!partition) return null;
                    return (
                      <button
                        className={
                          "practice-block practice-block--partition " +
                          (practiceSelectedIndex === index ? "practice-block--selected" : "")
                        }
                        type="button"
                        key={partition.id}
                        draggable={!practiceFinished}
                        onDragStart={() => setPracticeDragIndex(index)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (practiceDragIndex !== null) movePracticeItem(practiceDragIndex, index);
                        }}
                        onDragEnd={() => setPracticeDragIndex(null)}
                        onClick={() => handlePracticeBlockClick(index)}
                        aria-pressed={practiceSelectedIndex === index}
                      >
                        <span>[{partition.values.join(", ")}]</span>
                        <strong>μ {formatMean(partition.mean)}</strong>
                      </button>
                    );
                  })
                : practiceValues.map((value, index) => (
                    <button
                      className={
                        "practice-block " +
                        (practiceSelectedIndex === index ? "practice-block--selected" : "")
                      }
                      type="button"
                      key={value}
                      draggable={!practiceFinished}
                      onDragStart={() => setPracticeDragIndex(index)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (practiceDragIndex !== null) movePracticeItem(practiceDragIndex, index);
                      }}
                      onDragEnd={() => setPracticeDragIndex(null)}
                      onClick={() => handlePracticeBlockClick(index)}
                      aria-pressed={practiceSelectedIndex === index}
                    >
                      {value}
                    </button>
                  ))}
            </div>
            <div className="practice-lab__actions">
              {practiceFinished ? (
                <button className="button button--secondary" type="button" onClick={() => resetPractice()}>
                  Restart walkthrough
                </button>
              ) : (
                <>
                  <button className="button button--secondary" type="button" onClick={checkPracticeStep}>
                    Check step
                  </button>
                  <button className="text-button" type="button" onClick={() => resetPractice()}>
                    Reset walkthrough
                  </button>
                  {practiceSolved && (
                    <button className="button button--primary" type="button" onClick={advancePracticeStep}>
                      {practiceStepIndex === practiceSteps.length - 1 ? "Finish walkthrough" : "Next step"}
                    </button>
                  )}
                </>
              )}
            </div>
            <p className={"practice-lab__feedback " + (practiceSolved ? "practice-lab__feedback--success" : "")} aria-live="polite">
              {practiceFeedback ?? ""}
            </p>
          </div>
        </section>

        <section className="comparison-lab" aria-labelledby="comparison-title">
          <div className="comparison-lab__header">
            <div>
              <p className="eyebrow">EFFICIENCY LAB</p>
              <h2 id="comparison-title">Compare the work behind the motion.</h2>
              <p>
                Every deterministic algorithm receives the same shuffled sequence of 1 through n.
                These totals combine comparisons and writes, so they are operation estimates rather
                than timers. Mean Partition also counts every value read and rewritten during each
                grouping round, plus its group-ranking comparisons. Bogo Sort stays out of this chart
                because its expected work grows factorially, even though the live visualizer allows it
                up to 256 values.
              </p>
            </div>
            <label className="benchmark-select">
              <span>Test arrangement</span>
              <select
                value={benchmarkPattern}
                onChange={(event) => setBenchmarkPattern(event.target.value as BenchmarkPattern)}
                aria-label="Benchmark test arrangement"
              >
                <option value="random">Random shuffle</option>
                <option value="reverse">Reverse order</option>
                <option value="nearly-sorted">Nearly sorted</option>
              </select>
            </label>
          </div>

          <div
            className="benchmark-chart"
            role="img"
            aria-label={"Estimated work for insertion, cocktail, selection, heap, quick, merge, and mean partition sort on " + benchmarkPattern + " arrays from 16 through 256 values."}
          >
            <div className="benchmark-chart__scale">
              <span>{formatCount(benchmarkMaximum)} work units</span>
              <span>0</span>
            </div>
            <div className="benchmark-columns" aria-hidden="true">
              {benchmarkData.map((entry) => {
                return (
                  <div className="benchmark-group" key={entry.size}>
                    <div className="benchmark-bars">
                      {BENCHMARK_ALGORITHMS.map((benchmarkAlgorithm) => {
                        const height = Math.max(
                          3,
                          (entry.work[benchmarkAlgorithm.key] / benchmarkMaximum) * 100,
                        );
                        return (
                          <div
                            className={"benchmark-bar benchmark-bar--" + benchmarkAlgorithm.className}
                            key={benchmarkAlgorithm.key}
                            style={{ height: String(height) + "%" }}
                          />
                        );
                      })}
                    </div>
                    <span>n={entry.size}</span>
                  </div>
                );
              })}
            </div>
            <div className="benchmark-legend" aria-hidden="true">
              {BENCHMARK_ALGORITHMS.map((benchmarkAlgorithm) => (
                <span key={benchmarkAlgorithm.key}>
                  <i className={"benchmark-legend__swatch benchmark-legend__swatch--" + benchmarkAlgorithm.className} />
                  {benchmarkAlgorithm.label}
                </span>
              ))}
            </div>
          </div>

          <div className="benchmark-current" aria-label={"Current benchmark at " + arraySize + " values"}>
            {BENCHMARK_ALGORITHMS.map((benchmarkAlgorithm) => {
              const work = selectedBenchmark[benchmarkAlgorithm.key];
              return (
                <div key={benchmarkAlgorithm.key}>
                  <span>AT n={arraySize}</span>
                  <strong>{benchmarkAlgorithm.label}</strong>
                  <i>
                    <b
                      className={"benchmark-current__" + benchmarkAlgorithm.className}
                      style={{ width: String((work / selectedBenchmarkMaximum) * 100) + "%" }}
                    />
                  </i>
                  <em>{formatCount(work)} work units</em>
                </div>
              );
            })}
          </div>
        </section>

        <p className="sr-only" aria-live="polite" aria-atomic="true">{liveStatus}</p>
      </div>
    </main>
  );
}
