"use client";

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BOGO_MAX_ATTEMPTS,
  type BogoSession,
  analyzeBubbleSort,
  advanceBogoSession,
  analyzeCocktailSort,
  analyzeHeapSort,
  analyzeInsertionSort,
  analyzeMeanPartitionSort,
  analyzeRangeGuardMeanSort,
  analyzeMergeSort,
  analyzeQuickSort,
  analyzeSelectionSort,
  buildCocktailSteps,
  buildBubbleSteps,
  buildHeapSortSteps,
  buildMeanPartitionSteps,
  buildRangeGuardMeanSteps,
  buildMergeSortSteps,
  buildQuickSortSteps,
  buildSelectionSteps,
  createBogoSession,
  formatMean,
  getBogoSessionStep,
} from "./lib/sorting";

type AlgorithmId =
  | "insertion"
  | "bubble"
  | "cocktail"
  | "selection"
  | "heap"
  | "quick"
  | "merge"
  | "bogo"
  | "mean-partition"
  | "range-guard-mean";
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
type BenchmarkView = "theory" | "measured";

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

type MedianPracticeStep = {
  prompt: string;
  values: number[];
  targetMedian: number;
  hint: string;
  kind: "median";
};

type PracticeStep = BlockPracticeStep | PartitionPracticeStep | MedianPracticeStep;

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
const THEORY_BENCHMARK_SIZES = [16, 64, 256, 1_024, 4_096, 16_384, 65_536];
const BENCHMARK_ALGORITHMS = [
  { key: "bubble", label: "Bubble sort", className: "bubble" },
  { key: "insertion", label: "Insertion sort", className: "insertion" },
  { key: "cocktail", label: "Cocktail sort", className: "cocktail" },
  { key: "selection", label: "Selection sort", className: "selection" },
  { key: "heap", label: "Heap sort", className: "heap" },
  { key: "quick", label: "Quick sort", className: "quick" },
  { key: "merge", label: "Merge sort", className: "merge" },
  { key: "meanPartition", label: "Mean partition sort", className: "mean" },
  { key: "rangeGuardMean", label: "Range-Guard Median sort", className: "range-guard" },
] as const;
type BenchmarkAlgorithm = (typeof BENCHMARK_ALGORITHMS)[number]["key"];
type BenchmarkWork = Record<BenchmarkAlgorithm, number>;
const BOGO_MIN_ATTEMPTS = 1;
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

function getTheoreticalWork(
  algorithm: BenchmarkAlgorithm,
  size: number,
  pattern: BenchmarkPattern,
) {
  const n = Math.max(size, 2);
  const logN = Math.log2(n);
  const pairWork = (n * (n - 1)) / 2;

  switch (algorithm) {
    case "bubble":
      return pairWork * (pattern === "reverse" ? 2 : pattern === "nearly-sorted" ? 0.14 : 1);
    case "cocktail":
      return pairWork * (pattern === "reverse" ? 1.5 : pattern === "nearly-sorted" ? 0.12 : 0.82);
    case "selection":
      return pairWork;
    case "insertion":
      return pairWork * (pattern === "reverse" ? 2 : pattern === "nearly-sorted" ? 0.1 : 0.75);
    case "heap":
      return 2.6 * n * logN;
    case "quick":
      return pattern === "random"
        ? 1.7 * n * logN
        : pattern === "reverse"
          ? pairWork * 1.25
          : pairWork;
    case "merge":
      return 2 * n * logN;
    case "meanPartition":
      // Legacy mean ranking inserts k groups one by one each round. The
      // summed group-ranking work grows quadratically at large n.
      return (2 / 3) * n * n + 2 * n * logN;
    case "rangeGuardMean":
      // One or two small median guard passes are bounded; all remaining rounds
      // use fast mean ranking.
      return 3.4 * n * logN;
  }
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
    number: "04",
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
  bubble: {
    label: "Bubble sort",
    number: "02",
    heroCopy: "Compare neighboring values and let the largest one bubble to the right on every pass.",
    controlTitle: "Bubble the largest value right",
    stageLabel: "pass",
    stageDescription: "rightward neighbor sweep",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Let one large value rise at a time.",
    learnCopy: [
      "Bubble sort walks from left to right, looking at one neighboring pair at a time. If the pair is backwards, it swaps them. A large value can therefore keep trading places with its next neighbor and travel toward the right edge in one pass.",
      "After a full pass, the largest value that was still unsorted must be at the far right, so it never needs to be checked again. The next pass stops one position earlier. Bubble sort is simple and easy to see, but it repeats many neighbor comparisons on large rows.",
    ],
    complexity: ["BEST O(n)", "AVERAGE O(n²)", "SPACE O(1)"],
    cardTitle: "BUBBLE SORT",
    cardTag: "stable · neighbor swaps",
    steps: [
      "Compare the first pair of neighbors.",
      "Swap them only when the left value is larger.",
      "Continue right until the largest remaining value settles.",
    ],
    examples: [
      { values: "[4, 1, 3, 2]", detail: "Begin with 4 and 1. They are backwards, so 4 needs to move right." },
      { values: "[1, 4, 3, 2] → [1, 3, 4, 2]", detail: "4 meets 3 next and swaps again, continuing its trip right." },
      { values: "[1, 3, 2, 4]", detail: "After one full sweep, 4 is fixed at the far right; later passes work only to its left." },
    ],
    practice: [
      { prompt: "Start the bubble by moving 1 ahead of 4.", start: [4, 1, 3, 2], target: [1, 4, 3, 2], hint: "The first pair is backwards: 4 is larger than 1." },
      { prompt: "Keep 4 bubbling right past 3.", start: [1, 4, 3, 2], target: [1, 3, 4, 2], hint: "Compare the pair containing 4 and 3." },
      { prompt: "Finish the sweep by sending 4 to the right edge.", start: [1, 3, 4, 2], target: [1, 3, 2, 4], hint: "4 is still larger than the value beside it." },
      { prompt: "One more short pass fixes the middle pair and completes the sorted row.", start: [1, 3, 2, 4], target: [1, 2, 3, 4], hint: "Compare 3 and 2; the settled 4 stays at the right edge." },
    ],
  },
  cocktail: {
    label: "Cocktail sort",
    number: "03",
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
    number: "05",
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
    number: "06",
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
      { prompt: "Extract the remaining heap values to finish the ordered row.", start: [3, 2, 1, 4], target: [1, 2, 3, 4], hint: "The largest active value, 3, goes beside 4; the final two are already in order." },
    ],
  },
  quick: {
    label: "Quick sort",
    number: "07",
    heroCopy: "Choose a pivot, split smaller and larger values around it, then repeat on each side.",
    controlTitle: "Partition around a pivot",
    stageLabel: "partition",
    stageDescription: "pivot placement",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Put pivots in their final places.",
    learnCopy: [
      "Quick sort first chooses a pivot—this visualizer uses the rightmost value. Leave the pivot parked there for a moment and scan only the values before it. Keep an imaginary smaller-values area at the left edge: when you find a value no larger than the pivot, move it into the next open spot in that area.",
      "For [4, 1, 3 | 2], the pivot is 2. 4 is too large, so it remains on the future right side. 1 is small enough, so it moves into the smaller-values area. Then place 2 directly after that area: [1, 2 | 4, 3]. The pivot is now final; repeat the same tiny job only inside the left and right ranges.",
    ],
    complexity: ["AVERAGE O(n log n)", "WORST O(n²)", "SPACE O(log n)"],
    cardTitle: "QUICK SORT",
    cardTag: "in-place · pivot-based",
    steps: [
      "Park the rightmost pivot and scan the values before it.",
      "Grow a left area containing only values no larger than the pivot.",
      "Place the pivot after that area, then repeat on each side.",
    ],
    examples: [
      { values: "[4, 1, 3 | 2]", detail: "2 is the parked pivot. Scan 4, then 1, then 3; do not compare the pivot with the whole row at once." },
      { values: "[1 | 4, 3 | 2]", detail: "Only 1 belongs in the smaller area. 4 and 3 are simply waiting on the other side for now." },
      { values: "[1, 2 | 4, 3]", detail: "Swap the pivot into the gap after 1. Its final position is now fixed; only [4, 3] still needs work." },
    ],
    practice: [
      { prompt: "Pivot 2 stays parked at the far right. Move only the smaller value, 1, into the left area.", start: [4, 1, 3, 2], target: [1, 4, 3, 2], hint: "1 is the only value no larger than pivot 2; 4 and 3 wait to its right." },
      { prompt: "Now slide the parked pivot 2 into the gap immediately after the smaller area.", start: [1, 4, 3, 2], target: [1, 2, 4, 3], hint: "The pivot belongs after 1 and before both 4 and 3." },
      { prompt: "Ignore the fixed [1, 2] left side. Sort only the remaining right-side pair.", start: [1, 2, 4, 3], target: [1, 2, 3, 4], hint: "Quick sort now works only on the smaller range [4, 3]." },
    ],
  },
  merge: {
    label: "Merge sort",
    number: "08",
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
    number: "01",
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
    number: "09",
    heroCopy: "Split the row into more and more balanced groups, ranking whole groups by their averages each round.",
    controlTitle: "Rank balanced groups by mean",
    stageLabel: "round",
    stageDescription: "mean grouping",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Sort blocks before sorting values.",
    learnCopy: [
      "Mean partition sort repeatedly cuts the current row into balanced groups: first 2, then 4, then 8, and so on. It computes each group’s arithmetic mean—the sum divided by the number of values—and moves whole groups so lower means are left of higher means.",
      "A low group mean is a clue, not proof that every value in one group belongs before another. The basic model keeps splitting until singleton groups, where each mean equals the value itself. That final round makes the result exact.",
    ],
    complexity: ["PASSES O(log n)", "RANKING O(n²) WORST", "SPACE O(n)"],
    cardTitle: "MEAN PARTITION SORT",
    cardTag: "baseline · group-based",
    steps: [
      "Split the current row into 2, 4, 8… balanced groups.",
      "Calculate the average of every group.",
      "Rank every group from the smallest mean to the largest.",
      "Continue until singleton-group means are the values themselves.",
    ],
    examples: [
      { values: "[1, 100] μ=50.5 | [49, 50] μ=49.5", detail: "The second group has the lower average, even though 100 is still inside the first group." },
      { values: "[49, 50 | 1, 100]", detail: "The broad mean pass ranks 49.5 before 50.5; this is fast, but not yet a proof of order." },
      { values: "[1] [49] [50] [100]", detail: "At singleton groups, each mean equals its value, so ranking the groups gives the exact numeric order." },
      { values: "[1, 49, 50, 100]", detail: "The singleton round is the final exact numeric ranking." },
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
  "range-guard-mean": {
    label: "Range-Guard Median sort",
    number: "10",
    heroCopy: "Rank broad groups by average, use one short median cleanup for outliers, then return to fast mean ranking.",
    controlTitle: "Use a short median guard, then mean-rank",
    stageLabel: "round",
    stageDescription: "bounded median guard",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Clean up outliers briefly, then go back to averages.",
    learnCopy: [
      "Range-Guard Median sort begins with the same broad 2, 4, 8… mean-ranked groups as Mean Partition Sort. It uses a faster group-ranking path and deliberately does no range work while groups are still large.",
      "Once groups are roughly one quarter of the original row or smaller—capped at 16 values—the guard checks their minimum and maximum. Crossing groups get one median split, with a second only if a small, stubborn overlap remains. A median makes near-even halves, so a single extreme value cannot make a lopsided 15-versus-1 split. The guard then turns off and ordinary mean grouping finishes the job exactly at singleton groups.",
    ],
    complexity: ["PASSES O(log n)", "WORK O(n log n)", "SPACE O(n)"],
    cardTitle: "RANGE-GUARD MEDIAN SORT",
    cardTag: "adaptive · bounded cleanup",
    steps: [
      "Split the current row into 2, 4, 8… balanced groups.",
      "Calculate and quickly rank the average of every group.",
      "At small groups, use one or two median guard passes only for overlapping outlier groups.",
      "Return to mean ranking; singleton-group means are the values themselves.",
    ],
    examples: [
      { values: "[1, 100, 101, 102] | [48, 49, 50, 51]", detail: "Broad means can hide the 1 inside the first high-average group, so the row needs a targeted cleanup." },
      { values: "median([1, 100, 101, 102]) = 100", detail: "The lower median makes near-even sides: [1, 100] and [101, 102], instead of a lopsided mean split." },
      { values: "one or two guard passes", detail: "Only ranges that still cross are refined. The guard then shuts off instead of inspecting every later group." },
      { values: "mean groups → singleton means", detail: "Ordinary mean ranking resumes; the singleton pass still guarantees exact numeric order." },
    ],
    practice: [
      {
        kind: "median",
        prompt: "The overlap guard has isolated [1, 100, 101, 102]. Tap its lower median—the value that makes the two guard halves as even as possible.",
        values: [1, 100, 101, 102],
        targetMedian: 100,
        hint: "Sort mentally: 1, 100, 101, 102. For this even-sized block, use the lower middle value.",
      },
      {
        kind: "partitions",
        prompt: "After the short guard cleanup, return to the cheap rule: drag the lower-mean group before the higher-mean group.",
        partitions: [
          { id: "higher-mean", values: [12, 18], mean: 15 },
          { id: "lower-mean", values: [5, 11], mean: 8 },
        ],
        targetOrder: ["lower-mean", "higher-mean"],
        hint: "The expensive guard is over. Compare only μ 8 and μ 15, then rank the whole groups.",
      },
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
  refinementOperations?: number;
}) {
  return (
    metrics.comparisons +
    metrics.rankComparisons +
    metrics.writes +
    (metrics.meanComputationOperations ?? 0) +
    (metrics.refinementOperations ?? 0)
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
  if (algorithm === "mean-partition" || algorithm === "range-guard-mean") {
    if (step.phase === "complete") return "bar--sorted";
    if (step.phase === "split") return "bar--partition";
    if (step.phase === "average") return "bar--mean";
    if (step.phase === "reorder") return "bar--rank";
    return "bar--idle";
  }

  if (algorithm === "merge") {
    if (step.phase === "complete") return "bar--sorted";
    if (step.phase === "merge" && index === step.inserting) return "bar--merge";
    if (step.phase === "compare" && (index === step.comparing || index === step.shifting)) {
      return "bar--compare";
    }
    return "bar--idle";
  }

  if (algorithm === "bogo") {
    if (step.phase === "complete") return "bar--sorted";
    if (step.phase === "limited") return "bar--limited";
    if (step.phase === "shuffle") return "bar--shuffle";
    return "bar--idle";
  }

  if (algorithm === "quick") {
    if (step.phase === "complete") return "bar--sorted";
    // At dense sizes, coloring every newly placed pivot creates a noisy striped
    // row. Keep the in-progress state quiet and reserve the green line for the
    // completed sort; the active pivot and swap still show the current action.
    if (step.values.length <= DEFAULT_ARRAY_SIZE && step.settled?.includes(index)) {
      return "bar--sorted";
    }
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

  if (algorithm === "bubble" || algorithm === "cocktail") {
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
  const [bogoAttemptInput, setBogoAttemptInput] = useState(String(BOGO_MAX_ATTEMPTS));
  const [benchmarkPattern, setBenchmarkPattern] =
    useState<BenchmarkPattern>("random");
  const [benchmarkView, setBenchmarkView] = useState<BenchmarkView>("theory");
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
  const [practiceDraggingId, setPracticeDraggingId] = useState<string | null>(null);
  const [practiceDragOffset, setPracticeDragOffset] = useState({ x: 0, y: 0 });
  const [practiceDropIndex, setPracticeDropIndex] = useState<number | null>(null);
  const [practiceSolved, setPracticeSolved] = useState(false);
  const [practiceFeedback, setPracticeFeedback] = useState<string | null>(null);
  const [practiceUndoPending, setPracticeUndoPending] = useState(false);
  const [practiceMedianSelection, setPracticeMedianSelection] = useState<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastToneTimeRef = useRef(0);
  const lastBogoTextureTimeRef = useRef(0);
  const meanBarElementsRef = useRef(new Map<number, HTMLDivElement>());
  const meanBarPositionsRef = useRef(new Map<number, number>());
  const practiceBoardRef = useRef<HTMLDivElement | null>(null);
  const practiceBlockElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const practiceBlockPositionsRef = useRef(new Map<string, { left: number; top: number }>());
  const practicePointerRef = useRef<{
    id: string;
    fromIndex: number;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressPracticeClickRef = useRef(false);
  const practiceUndoTimerRef = useRef<number | null>(null);
  const bogoSessionRef = useRef<BogoSession | null>(null);
  const [meanSlideOffsets, setMeanSlideOffsets] = useState<Record<number, number>>({});
  const [meanSlideStage, setMeanSlideStage] = useState<"idle" | "prepare" | "animate">("idle");
  const prefersReducedMotion = usePrefersReducedMotion();
  const isMeanPartition = algorithm === "mean-partition" || algorithm === "range-guard-mean";
  const isRangeGuardMean = algorithm === "range-guard-mean";
  const isBogo = algorithm === "bogo";
  const bogoAttemptMaximum = getBogoAttemptMaximum(arraySize);
  const bogoSliderStep = 1;
  const soundEnabled = soundVolume > 0;
  const algorithmDetails = ALGORITHM_DETAILS[algorithm];
  const practiceSteps = algorithmDetails.practice;
  const practiceFinished = practiceStepIndex >= practiceSteps.length;
  const currentPractice = practiceSteps[Math.min(practiceStepIndex, practiceSteps.length - 1)];
  const isPartitionPractice = currentPractice.kind === "partitions";
  const isMedianPractice = currentPractice.kind === "median";
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
        const bubble = analyzeBubbleSort(benchmarkValues);
        const insertion = analyzeInsertionSort(benchmarkValues);
        const cocktail = analyzeCocktailSort(benchmarkValues);
        const selection = analyzeSelectionSort(benchmarkValues);
        const heap = analyzeHeapSort(benchmarkValues);
        const quick = analyzeQuickSort(benchmarkValues);
        const merge = analyzeMergeSort(benchmarkValues);
        const meanPartition = analyzeMeanPartitionSort(benchmarkValues);
        const rangeGuardMean = analyzeRangeGuardMeanSort(benchmarkValues);

        return {
          size,
          work: {
            bubble: getWorkEstimate(bubble),
            insertion: getWorkEstimate(insertion),
            cocktail: getWorkEstimate(cocktail),
            selection: getWorkEstimate(selection),
            heap: getWorkEstimate(heap),
            quick: getWorkEstimate(quick),
            merge: getWorkEstimate(merge),
            meanPartition: getWorkEstimate(meanPartition),
            rangeGuardMean: getWorkEstimate(rangeGuardMean),
          } satisfies BenchmarkWork,
        };
      }),
    [benchmarkPattern],
  );
  const selectedBenchmark = useMemo(() => {
    const benchmarkValues = makeBenchmarkArray(arraySize, benchmarkPattern);
    const bubble = analyzeBubbleSort(benchmarkValues);
    const insertion = analyzeInsertionSort(benchmarkValues);
    const cocktail = analyzeCocktailSort(benchmarkValues);
    const selection = analyzeSelectionSort(benchmarkValues);
    const heap = analyzeHeapSort(benchmarkValues);
    const quick = analyzeQuickSort(benchmarkValues);
    const merge = analyzeMergeSort(benchmarkValues);
    const meanPartition = analyzeMeanPartitionSort(benchmarkValues);
    const rangeGuardMean = analyzeRangeGuardMeanSort(benchmarkValues);

    return {
      bubble: getWorkEstimate(bubble),
      insertion: getWorkEstimate(insertion),
      cocktail: getWorkEstimate(cocktail),
      selection: getWorkEstimate(selection),
      heap: getWorkEstimate(heap),
      quick: getWorkEstimate(quick),
      merge: getWorkEstimate(merge),
      meanPartition: getWorkEstimate(meanPartition),
      rangeGuardMean: getWorkEstimate(rangeGuardMean),
    } satisfies BenchmarkWork;
  }, [arraySize, benchmarkPattern]);
  const theoreticalBenchmarkData = useMemo(
    () =>
      THEORY_BENCHMARK_SIZES.map((size) => ({
        size,
        work: Object.fromEntries(
          BENCHMARK_ALGORITHMS.map((benchmarkAlgorithm) => [
            benchmarkAlgorithm.key,
            getTheoreticalWork(benchmarkAlgorithm.key, size, benchmarkPattern),
          ]),
        ) as BenchmarkWork,
      })),
    [benchmarkPattern],
  );
  const displayedBenchmarkData = benchmarkView === "theory" ? theoreticalBenchmarkData : benchmarkData;
  const orderedBenchmarkAlgorithms = useMemo(() => {
    const finalColumn = displayedBenchmarkData.at(-1)?.work;

    return [...BENCHMARK_ALGORITHMS].sort((left, right) => {
      const difference = (finalColumn?.[right.key] ?? 0) - (finalColumn?.[left.key] ?? 0);
      return difference || BENCHMARK_ALGORITHMS.indexOf(left) - BENCHMARK_ALGORITHMS.indexOf(right);
    });
  }, [displayedBenchmarkData]);
  const orderedCurrentBenchmarkAlgorithms = useMemo(
    () =>
      [...BENCHMARK_ALGORITHMS].sort((left, right) => {
        const difference = selectedBenchmark[right.key] - selectedBenchmark[left.key];
        return difference || BENCHMARK_ALGORITHMS.indexOf(left) - BENCHMARK_ALGORITHMS.indexOf(right);
      }),
    [selectedBenchmark],
  );
  const benchmarkMatrixStyle = {
    "--benchmark-columns": displayedBenchmarkData.length,
    minWidth: String(180 + displayedBenchmarkData.length * 118) + "px",
  } as CSSProperties;
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
    const shouldAnimateMeanMove =
      currentStep.phase === "reorder" ||
      (isRangeGuardMean &&
        currentStep.phase === "split" &&
        currentStep.message.includes("overlap guard"));
    if (!shouldAnimateMeanMove) {
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
  }, [currentStep.message, currentStep.pass, currentStep.phase, isMeanPartition, isRangeGuardMean, prefersReducedMotion, visibleValues]);

  useLayoutEffect(() => {
    const previousPositions = practiceBlockPositionsRef.current;
    const nextPositions = capturePracticeBlockPositions();

    if (!prefersReducedMotion) {
      nextPositions.forEach((nextPosition, id) => {
        const previousPosition = previousPositions.get(id);
        const element = practiceBlockElementsRef.current.get(id);
        if (!previousPosition || !element) return;

        const deltaX = previousPosition.left - nextPosition.left;
        const deltaY = previousPosition.top - nextPosition.top;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

        element.getAnimations().forEach((animation) => animation.cancel());
        element.animate(
          [
            { transform: "translate(" + deltaX + "px, " + deltaY + "px) scale(1.025)" },
            { transform: "translate(0, 0) scale(1)" },
          ],
          { duration: 330, easing: "cubic-bezier(.22, .9, .3, 1)" },
        );
      });
    }

    practiceBlockPositionsRef.current = nextPositions;
  }, [practicePartitionOrder, practiceStepIndex, practiceValues, prefersReducedMotion]);

  const isLocked = runState === "running" || runState === "paused";
  const isLargeArray = originalValues.length > DEFAULT_ARRAY_SIZE;
  const playbackDensity = isBogo ? 48 : 1;
  const speedDelay = 720 - speed * 7.13;
  const meanSlideDuration = Math.round(Math.max(520, 1_050 - speed * 5.3));
  const meanStaticDelay = Math.max(190, 620 - speed * 4);
  const minimumFrameDelay = isLargeArray && !isBogo ? 16 : 7;
  const bogoSlowMotionDelay =
    isBogo && originalValues.length <= DEFAULT_ARRAY_SIZE
      ? Math.round(440 * (1 - (speed - 1) / 99) ** 3)
      : 0;
  const usesEvenMergePacing =
    algorithm === "merge" &&
    currentStep.phase !== "ready" &&
    currentStep.phase !== "complete";
  const mergePassDuration = Math.max(600, 3_400 - speed * 28);
  const mergeFramesInCurrentPass = mergePassFrameCounts.get(currentStep.pass) ?? 1;
  const delay = prefersReducedMotion
    ? 18
    : isMeanPartition
      ? currentStep.phase === "reorder" ||
          (isRangeGuardMean &&
            currentStep.phase === "split" &&
            currentStep.message.includes("overlap guard"))
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
    const cooldown = isLargeArray ? 0.045 : 0.028;
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

  function playBogoShuffleTexture(attempt: number) {
    const context = audioContextRef.current;
    if (!context || context.state !== "running" || soundVolume <= 0) return;

    const now = context.currentTime;
    if (now - lastBogoTextureTimeRef.current < 0.13) return;
    lastBogoTextureTimeRef.current = now;

    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const motion = ((attempt * 0.61803398875) % 1 + 1) % 1;
    const frequency = 145 + motion * 330;
    const peakGain = 0.17 * (soundVolume / 100) ** 2.15;

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.72, now + 0.07);
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(750 + motion * 500, now);
    filter.Q.value = 1.1;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.09);
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
      isBogo ||
      !soundEnabled ||
      runState !== "running" ||
      stepIndex === 0 ||
      !AUDIBLE_PHASES.includes(currentStep.phase)
    ) {
      return;
    }

    playSortingTone(currentStep);
  }, [currentStep, isBogo, runState, soundEnabled, stepIndex]);

  useEffect(() => {
    if (!isBogo || !soundEnabled || runState !== "running") return;

    let cancelled = false;
    const playTexture = () => {
      const session = bogoSessionRef.current;
      if (!cancelled && session && !session.done) playBogoShuffleTexture(session.attempts);
    };
    const context = ensureAudioContext();
    void context.resume().then(playTexture).catch(() => undefined);
    const timer = window.setInterval(playTexture, 145);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isBogo, runState, soundEnabled, soundVolume]);

  useEffect(() => {
    if (!isBogo || runState !== "running") return;

    const session = bogoSessionRef.current;
    if (!session) return;

    let cancelled = false;
    let timer: number | undefined;

    const runBatch = () => {
      if (cancelled || bogoSessionRef.current !== session) return;

      if (bogoSlowMotionDelay > 0) {
        advanceBogoSession(session);
      } else {
        const deadline = performance.now() + 8;
        do {
          advanceBogoSession(session);
        } while (!session.done && performance.now() < deadline);
      }

      setBogoLiveStep(getBogoSessionStep(session));
      if (session.done) {
        setRunState("complete");
        return;
      }

      timer = window.setTimeout(runBatch, bogoSlowMotionDelay);
    };

    timer = window.setTimeout(runBatch, 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [bogoSlowMotionDelay, isBogo, runState]);

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

  function clearPracticeUndo() {
    if (practiceUndoTimerRef.current !== null) {
      window.clearTimeout(practiceUndoTimerRef.current);
      practiceUndoTimerRef.current = null;
    }
    setPracticeUndoPending(false);
  }

  function resetPractice(nextAlgorithm = algorithm) {
    clearPracticeUndo();
    const firstStep = ALGORITHM_DETAILS[nextAlgorithm].practice[0];
    setPracticeStepIndex(0);
    setPracticeSelectedIndex(null);
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropIndex(null);
    practicePointerRef.current = null;
    setPracticeSolved(false);
    setPracticeFeedback(null);
    setPracticeMedianSelection(null);

    if (firstStep.kind === "partitions") {
      setPracticeValues([]);
      setPracticePartitionOrder(firstStep.partitions.map((partition) => partition.id));
      return;
    }

    if (firstStep.kind === "median") {
      setPracticeValues([]);
      setPracticePartitionOrder([]);
      return;
    }

    setPracticeValues([...firstStep.start]);
    setPracticePartitionOrder([]);
  }

  function capturePracticeBlockPositions() {
    const positions = new Map<string, { left: number; top: number }>();
    practiceBlockElementsRef.current.forEach((element, id) => {
      const { left, top } = element.getBoundingClientRect();
      positions.set(id, { left, top });
    });
    return positions;
  }

  function setPracticeBlockRef(id: string, element: HTMLButtonElement | null) {
    if (element) {
      practiceBlockElementsRef.current.set(id, element);
      return;
    }
    practiceBlockElementsRef.current.delete(id);
  }

  function evaluatePracticeMove(nextValues: number[], nextPartitionOrder: string[]) {
    const isCorrect =
      currentPractice.kind === "partitions"
        ? currentPractice.targetOrder.every(
            (partitionId, index) => nextPartitionOrder[index] === partitionId,
          )
        : currentPractice.kind === "median"
          ? false
          : currentPractice.target.every((value, index) => nextValues[index] === value);

    setPracticeSolved(isCorrect);
    setPracticeFeedback(
      isCorrect
        ? practiceStepIndex === practiceSteps.length - 1
          ? "Correct—this completes the walkthrough."
          : "Correct. Your move follows the rule; continue to the next step."
        : "Not quite. Hint: " + currentPractice.hint,
    );
    return isCorrect;
  }

  function handleMedianPracticeChoice(value: number) {
    if (practiceFinished || practiceUndoPending || currentPractice.kind !== "median") return;

    setPracticeMedianSelection(value);
    const isCorrect = value === currentPractice.targetMedian;
    setPracticeSolved(isCorrect);
    if (isCorrect) {
      setPracticeFeedback(
        practiceStepIndex === practiceSteps.length - 1
          ? "Correct—this completes the walkthrough."
          : "Correct. That lower median makes a balanced guard split; continue to the mean-ranking step.",
      );
      return;
    }

    setPracticeUndoPending(true);
    setPracticeFeedback("Not quite. The choice will clear so you can try the median again. Hint: " + currentPractice.hint);
    practiceUndoTimerRef.current = window.setTimeout(() => {
      setPracticeMedianSelection(null);
      setPracticeUndoPending(false);
      practiceUndoTimerRef.current = null;
    }, 560);
  }

  function schedulePracticeUndo(previousValues: number[], previousPartitionOrder: string[]) {
    setPracticeUndoPending(true);
    practiceUndoTimerRef.current = window.setTimeout(() => {
      if (isPartitionPractice) {
        setPracticePartitionOrder(previousPartitionOrder);
      } else {
        setPracticeValues(previousValues);
      }
      setPracticeFeedback("That move breaks this step's rule, so it slid back. Hint: " + currentPractice.hint);
      practiceUndoTimerRef.current = null;
      setPracticeUndoPending(false);
    }, 440);
  }

  function movePracticeItem(fromIndex: number, toIndex: number, capturePosition = true) {
    if (practiceFinished || practiceUndoPending || fromIndex === toIndex) return;
    if (capturePosition) {
      practiceBlockPositionsRef.current = capturePracticeBlockPositions();
    }

    if (isPartitionPractice) {
      const previousOrder = [...practicePartitionOrder];
      const nextOrder = [...practicePartitionOrder];
      const [moved] = nextOrder.splice(fromIndex, 1);
      nextOrder.splice(toIndex, 0, moved);
      setPracticePartitionOrder(nextOrder);
      if (!evaluatePracticeMove(practiceValues, nextOrder)) {
        schedulePracticeUndo(practiceValues, previousOrder);
      }
    } else {
      const previousValues = [...practiceValues];
      const nextValues = [...practiceValues];
      const [moved] = nextValues.splice(fromIndex, 1);
      nextValues.splice(toIndex, 0, moved);
      setPracticeValues(nextValues);
      if (!evaluatePracticeMove(nextValues, practicePartitionOrder)) {
        schedulePracticeUndo(previousValues, practicePartitionOrder);
      }
    }

    setPracticeSelectedIndex(null);
  }

  function handlePracticeBlockClick(index: number) {
    if (practiceFinished || practiceUndoPending) return;
    if (suppressPracticeClickRef.current) {
      suppressPracticeClickRef.current = false;
      return;
    }
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

  function getPracticeDropIndex(clientX: number, clientY: number) {
    const board = practiceBoardRef.current;
    if (!board) return null;

    const blocks = Array.from(board.querySelectorAll<HTMLButtonElement>("[data-practice-index]"));
    let nearestIndex: number | null = null;
    let nearestDistance = Infinity;

    blocks.forEach((block) => {
      const rect = block.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distance = (clientX - centerX) ** 2 + (clientY - centerY) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = Number(block.dataset.practiceIndex);
      }
    });

    return nearestIndex;
  }

  function finishPracticeDrag(cancelled = false) {
    const drag = practicePointerRef.current;
    if (!drag) return;

    const destination = practiceDropIndex;
    const shouldMove = !cancelled && drag.moved && destination !== null && destination !== drag.fromIndex;
    if (shouldMove) {
      practiceBlockPositionsRef.current = capturePracticeBlockPositions();
      suppressPracticeClickRef.current = true;
      movePracticeItem(drag.fromIndex, destination, false);
    }

    practicePointerRef.current = null;
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropIndex(null);
  }

  function handlePracticePointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    index: number,
    id: string,
  ) {
    if (practiceFinished || practiceUndoPending || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    practicePointerRef.current = {
      id,
      fromIndex: index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    setPracticeDragIndex(index);
    setPracticeDraggingId(id);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropIndex(index);
  }

  function handlePracticePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = practicePointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const x = event.clientX - drag.startX;
    const y = event.clientY - drag.startY;
    if (Math.abs(x) + Math.abs(y) > 5) drag.moved = true;
    if (!drag.moved) return;

    event.preventDefault();
    setPracticeDragOffset({ x, y });
    const destination = getPracticeDropIndex(event.clientX, event.clientY);
    setPracticeDropIndex((current) => (current === destination ? current : destination));
  }

  function advancePracticeStep() {
    clearPracticeUndo();
    const nextStepIndex = practiceStepIndex + 1;
    if (nextStepIndex >= practiceSteps.length) {
      setPracticeStepIndex(practiceSteps.length);
      setPracticeSelectedIndex(null);
      setPracticeDragIndex(null);
      setPracticeDraggingId(null);
      setPracticeDragOffset({ x: 0, y: 0 });
      setPracticeDropIndex(null);
      practicePointerRef.current = null;
      setPracticeSolved(false);
      setPracticeMedianSelection(null);
      return;
    }

    const nextStep = practiceSteps[nextStepIndex];
    setPracticeStepIndex(nextStepIndex);
    setPracticeSelectedIndex(null);
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropIndex(null);
    practicePointerRef.current = null;
    setPracticeSolved(false);
    setPracticeFeedback(null);
    setPracticeMedianSelection(null);

    if (nextStep.kind === "partitions") {
      setPracticeValues([]);
      setPracticePartitionOrder(nextStep.partitions.map((partition) => partition.id));
      return;
    }

    if (nextStep.kind === "median") {
      setPracticeValues([]);
      setPracticePartitionOrder([]);
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

    const audioContext = soundEnabled ? ensureAudioContext() : null;
    setBogoCelebration(false);
    if (algorithm === "bogo") {
      if (audioContext) {
        // Start one texture in the click gesture. Fast Bogo batches can finish
        // before the normal interval has time to produce an audible note.
        void audioContext.resume().then(() => playBogoShuffleTexture(0)).catch(() => undefined);
      }
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
      algorithm === "range-guard-mean"
        ? buildRangeGuardMeanSteps(originalValues)
        : algorithm === "mean-partition"
        ? buildMeanPartitionSteps(originalValues)
        : algorithm === "bubble"
          ? buildBubbleSteps(originalValues)
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
      setBogoAttemptInput(String(nextBogoAttemptMaximum));
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
    setBogoAttemptInput(String(clampedLimit));
  }

  function normalizeBogoAttemptInput() {
    const candidate = Math.round(Number(bogoAttemptInput));
    if (!Number.isFinite(candidate)) {
      setBogoAttemptInput(String(bogoAttemptLimit));
      return;
    }
    handleBogoAttemptLimitChange(candidate);
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
                    <option value="bogo">Bogo sort</option>
                    <option value="bubble">Bubble sort</option>
                    <option value="cocktail">Cocktail sort</option>
                    <option value="insertion">Insertion sort</option>
                    <option value="selection">Selection sort</option>
                    <option value="heap">Heap sort</option>
                    <option value="quick">Quick sort</option>
                    <option value="merge">Merge sort</option>
                    <option value="mean-partition">Mean partition sort</option>
                    <option value="range-guard-mean">Range-Guard Median sort</option>
                  </select>
                </label>

                {isBogo && (
                  <label className="control-field control-field--range bogo-attempt-limit">
                    <span className="control-label">
                      Max shuffles
                      <input
                        className="control-number control-number--bogo"
                        type="number"
                        min={BOGO_MIN_ATTEMPTS}
                        max={bogoAttemptMaximum}
                        step="1"
                        value={bogoAttemptInput}
                        onChange={(event) => setBogoAttemptInput(event.target.value)}
                        onBlur={normalizeBogoAttemptInput}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        disabled={isLocked}
                        aria-label="Maximum Bogo Sort shuffles exact value"
                      />
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
                    <span><i className="legend__swatch legend__swatch--partition" />{isRangeGuardMean ? "group / guard split" : "split groups"}</span>
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
                ) : algorithm === "bubble" ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />unsorted</span>
                    <span><i className="legend__swatch legend__swatch--compare" />neighbors checked</span>
                    <span><i className="legend__swatch legend__swatch--swap" />swap</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />settled right edge</span>
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
                <h3 id="practice-title">Move the blocks and see the rule.</h3>
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
              {isMedianPractice
                ? "Choose the lower median to create two near-even outlier-guard halves. A wrong choice clears itself so you can try again."
                : "Pick up a block and drag it into place, or select one block and then select its destination. Each move is checked immediately."}
            </p>
            <div
              className="practice-board"
              ref={practiceBoardRef}
              role="group"
              aria-label={algorithmLabel + " interactive practice blocks"}
            >
              {isMedianPractice && currentPractice.kind === "median"
                ? currentPractice.values.map((value) => (
                    <button
                      className={
                        "practice-block practice-block--median " +
                        (practiceMedianSelection === value ? "practice-block--selected" : "")
                      }
                      type="button"
                      key={value}
                      onClick={() => handleMedianPracticeChoice(value)}
                      disabled={practiceUndoPending || practiceSolved}
                      aria-pressed={practiceMedianSelection === value}
                    >
                      <span>{value}</span>
                      <strong>median?</strong>
                    </button>
                  ))
                : isPartitionPractice
                ? practicePartitionOrder.map((partitionId, index) => {
                    const partition = currentPractice.partitions.find(
                      (candidate) => candidate.id === partitionId,
                    );
                    if (!partition) return null;
                    const practiceItemId = "partition-" + partition.id;
                    const isDragging = practiceDraggingId === practiceItemId;
                    return (
                      <button
                        className={
                          "practice-block practice-block--partition " +
                          (practiceSelectedIndex === index ? "practice-block--selected " : "") +
                          (isDragging ? "practice-block--dragging " : "") +
                          (practiceDropIndex === index && practiceDragIndex !== index
                            ? "practice-block--drop-target"
                            : "")
                        }
                        type="button"
                        key={partition.id}
                        ref={(element) => setPracticeBlockRef(practiceItemId, element)}
                        data-practice-index={index}
                        onPointerDown={(event) => handlePracticePointerDown(event, index, practiceItemId)}
                        onPointerMove={handlePracticePointerMove}
                        onPointerUp={() => finishPracticeDrag()}
                        onPointerCancel={() => finishPracticeDrag(true)}
                        onClick={() => handlePracticeBlockClick(index)}
                        disabled={practiceUndoPending}
                        aria-pressed={practiceSelectedIndex === index}
                        aria-grabbed={isDragging}
                        style={
                          isDragging
                            ? {
                                transform:
                                  "translate(" +
                                  practiceDragOffset.x +
                                  "px, " +
                                  practiceDragOffset.y +
                                  "px) scale(1.04)",
                              }
                            : undefined
                        }
                      >
                        <span>[{partition.values.join(", ")}]</span>
                        <strong>μ {formatMean(partition.mean)}</strong>
                      </button>
                    );
                  })
                : practiceValues.map((value, index) => {
                      const practiceItemId = "value-" + value;
                      const isDragging = practiceDraggingId === practiceItemId;
                      return (
                        <button
                          className={
                            "practice-block " +
                            (practiceSelectedIndex === index ? "practice-block--selected " : "") +
                            (isDragging ? "practice-block--dragging " : "") +
                            (practiceDropIndex === index && practiceDragIndex !== index
                              ? "practice-block--drop-target"
                              : "")
                          }
                          type="button"
                          key={value}
                          ref={(element) => setPracticeBlockRef(practiceItemId, element)}
                          data-practice-index={index}
                          onPointerDown={(event) => handlePracticePointerDown(event, index, practiceItemId)}
                          onPointerMove={handlePracticePointerMove}
                          onPointerUp={() => finishPracticeDrag()}
                          onPointerCancel={() => finishPracticeDrag(true)}
                          onClick={() => handlePracticeBlockClick(index)}
                          disabled={practiceUndoPending}
                          aria-pressed={practiceSelectedIndex === index}
                          aria-grabbed={isDragging}
                          style={
                            isDragging
                              ? {
                                  transform:
                                    "translate(" +
                                    practiceDragOffset.x +
                                    "px, " +
                                    practiceDragOffset.y +
                                    "px) scale(1.04)",
                                }
                              : undefined
                          }
                        >
                          {value}
                        </button>
                      );
                    })}
            </div>
            <div className="practice-lab__actions">
              {practiceFinished ? (
                <button className="button button--secondary" type="button" onClick={() => resetPractice()}>
                  Restart walkthrough
                </button>
              ) : (
                <>
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
                Switch between exact operation estimates for arrays up to 256 and a theoretical
                projection that makes the growth shape visible through 65,536 values. Bogo Sort stays
                out of both views because its expected work grows factorially.
              </p>
            </div>
            <div className="benchmark-controls">
              <label className="benchmark-select">
                <span>Chart view</span>
                <select
                  value={benchmarkView}
                  onChange={(event) => setBenchmarkView(event.target.value as BenchmarkView)}
                  aria-label="Efficiency chart view"
                >
                  <option value="theory">Theory through 65,536</option>
                  <option value="measured">Exact work through 256</option>
                </select>
              </label>
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
          </div>

          <div
            className="benchmark-chart"
            role="img"
            aria-label={
              benchmarkView === "theory"
                ? "Theoretical work growth, ordered from least to most efficient, for " + benchmarkPattern + " arrays from 16 through 65,536 values."
                : "Estimated work, ordered from least to most efficient, for " + benchmarkPattern + " arrays from 16 through 256 values."
            }
          >
            <p className="benchmark-chart__note">
              {benchmarkView === "theory"
                ? "Projected work uses each implementation's dominant growth model and the selected arrangement. Meter length uses a log scale, so O(n log n) curves remain visible next to quadratic ones; the printed number is a relative model unit, not a timed result."
                : "Each column compares algorithms at that exact array size. Meter length uses a log scale so the faster algorithms remain visible; the printed number is the exact work estimate."}
            </p>
            <p className="benchmark-chart__order">Rows run from least efficient at the top to most efficient at the bottom, based on the rightmost size.</p>
            <div className="benchmark-matrix" style={benchmarkMatrixStyle}>
              <div className="benchmark-matrix__header">
                <span>Algorithm</span>
                {displayedBenchmarkData.map((entry) => <span key={entry.size}>n={formatCount(entry.size)}</span>)}
              </div>
              {orderedBenchmarkAlgorithms.map((benchmarkAlgorithm) => (
                <div className="benchmark-matrix__row" key={benchmarkAlgorithm.key}>
                  <span className="benchmark-matrix__label">
                    <i className={"benchmark-legend__swatch benchmark-legend__swatch--" + benchmarkAlgorithm.className} />
                    {benchmarkAlgorithm.label}
                  </span>
                  {displayedBenchmarkData.map((entry) => {
                    const work = entry.work[benchmarkAlgorithm.key];
                    const columnMaximum = Math.max(1, ...Object.values(entry.work));
                    const ratio = Math.log1p(work) / Math.log1p(columnMaximum);
                    return (
                      <span className="benchmark-matrix__cell" key={entry.size}>
                        <strong>{formatCount(work)}</strong>
                        <i>
                          <b
                            className={"benchmark-meter--" + benchmarkAlgorithm.className}
                            style={{ width: String(ratio * 100) + "%" }}
                          />
                        </i>
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="benchmark-current" aria-label={"Current benchmark at " + arraySize + " values"}>
            <p className="benchmark-current__title">Exact totals at n={arraySize} · least to most efficient</p>
            {orderedCurrentBenchmarkAlgorithms.map((benchmarkAlgorithm) => {
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
