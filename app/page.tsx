"use client";

import {
  Fragment,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
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
  buildCocktailSteps,
  buildBubbleSteps,
  buildHeapSortSteps,
  buildMergeSortSteps,
  buildPdqSortSteps,
  buildPowerSortSteps,
  buildQuickSortSteps,
  buildSelectionSteps,
  createBogoSession,
  getBogoSessionStep,
} from "./lib/sorting";
import {
  applyPracticeMove,
  isPracticeRowFinished,
  isPracticeMoveProgress,
  resolvePracticeDropTarget,
  type PracticeDropMode,
  type PracticeDropRegion,
  type PracticeDropTarget,
} from "./lib/practice";
import {
  createSmallArrayPianoToneMap,
  getContinuousToneFrequency,
} from "./lib/audio";

type AlgorithmId =
  | "insertion"
  | "bubble"
  | "cocktail"
  | "selection"
  | "heap"
  | "quick"
  | "pdq"
  | "merge"
  | "powersort"
  | "bogo";
type RunState = "ready" | "running" | "paused" | "complete";
type StepPhase =
  | "ready"
  | "select"
  | "compare"
  | "shift"
  | "insert"
  | "split"
  | "swap"
  | "sweep"
  | "heapify"
  | "merge"
  | "run"
  | "power"
  | "shuffle"
  | "limited"
  | "complete";

type BenchmarkPattern = "random" | "reverse" | "nearly-sorted";
type BenchmarkTab = "table" | "lines";
type GrowthView = {
  zoom: number;
  centerX: number;
  centerY: number;
};
type GrowthGraphDomain = {
  minimumExponent: number;
  maximumExponent: number;
  exponentSpan: number;
};
type GrowthViewport = GrowthGraphDomain & {
  zoom: number;
  xStart: number;
  xEnd: number;
  xSpan: number;
  yMinimum: number;
  yMaximum: number;
  ySpan: number;
};

type PracticeGroupTone = "cyan" | "violet" | "mint" | "gold";

type PracticeGroup = {
  /** Inclusive slot range occupied by this visible run in the lesson row. */
  range: [number, number];
  /** Plain-language name shown in the run key and announced to screen readers. */
  label: string;
  /** A short explanation of what this run is doing in the current step. */
  detail?: string;
  /** Matching color for the run key and the bars on its blocks. */
  tone: PracticeGroupTone;
  /** Marks the runs the learner should work with in this step. */
  active?: boolean;
};

type BlockPracticeStep = {
  prompt: string;
  start: number[];
  target: number[];
  hint: string;
  kind?: "blocks";
  /** Quick Sort's currently parked pivot, when this is a pivot lesson step. */
  pivot?: number;
  /** Inclusive indices for the only sub-array the current pivot may affect. */
  activeRange?: [number, number];
  /** Values whose final positions are already proven by earlier pivots. */
  settled?: number[];
  /** Visible run boundaries for merge-style lessons. Ranges use row slots. */
  groups?: PracticeGroup[];
};

type PracticeStep = BlockPracticeStep;

type PracticeMoveResult = "complete" | "solved" | "progress" | "wrong";

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
  settled?: number[];
  visualSettled?: number[];
  rangeStart?: number;
  rangeEnd?: number;
  nodePower?: number;
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
];

const DEFAULT_ARRAY_SIZE = 24;
const DEFAULT_SPEED = 62;
// The interface stays on a familiar 1–100% scale while deterministic sorts
// keep the wider playback range that makes the top end feel responsive.
const MAX_SPEED = 200;
const DISPLAY_SPEED_MAX = 100;
const BOGO_MAX_ARRAY_SIZE = 24;
// A dense, bar-only verification scan needs enough time for the eye to read
// the order, but not so much that a 256-value finish becomes its own scene.
const COMPLETION_SWEEP_MIN_DURATION = 425;
const COMPLETION_SWEEP_MILLISECONDS_PER_BAR = 5;
const COMPLETION_SWEEP_AUDIO_VISUAL_LEAD = 24;
const COMPLETION_SWEEP_RELEASE_TAIL = 70;
const BOGO_COMPLETION_SWEEP_DELAY = 720;
// Keep the win message on screen long enough to read, then let its exit
// animation finish before removing it from the DOM.
const BOGO_CELEBRATION_VISIBLE_DURATION = 4_800;
const BOGO_CELEBRATION_FADE_DURATION = 560;
const THEORY_BENCHMARK_SIZES = [256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576];
const BENCHMARK_ALGORITHMS = [
  { key: "bubble", label: "Bubble sort", className: "bubble" },
  { key: "insertion", label: "Insertion sort", className: "insertion" },
  { key: "cocktail", label: "Cocktail sort", className: "cocktail" },
  { key: "selection", label: "Selection sort", className: "selection" },
  { key: "heap", label: "Heap sort", className: "heap" },
  { key: "quick", label: "Quick sort", className: "quick" },
  { key: "pdq", label: "PDQ sort", className: "pdq" },
  { key: "merge", label: "Merge sort", className: "merge" },
  { key: "powersort", label: "Powersort", className: "powersort" },
] as const;
type BenchmarkAlgorithm = (typeof BENCHMARK_ALGORITHMS)[number]["key"];
type BenchmarkWork = Record<BenchmarkAlgorithm, number>;
const BENCHMARK_COLORS: Record<BenchmarkAlgorithm, string> = {
  bubble: "#e58bc3",
  insertion: "#9789ff",
  cocktail: "#f09372",
  selection: "#e6a45d",
  heap: "#78a9f0",
  quick: "#72d79a",
  pdq: "#72c9e3",
  merge: "#edc05a",
  powersort: "#bd91f5",
};
const DEFAULT_GROWTH_ALGORITHM_VISIBILITY: Record<BenchmarkAlgorithm, boolean> = {
  bubble: true,
  insertion: true,
  cocktail: true,
  selection: true,
  heap: true,
  quick: true,
  pdq: true,
  merge: true,
  powersort: true,
};
const GROWTH_GRAPH_WIDTH = 920;
const GROWTH_GRAPH_HEIGHT = 356;
const GROWTH_GRAPH_PLOT_LEFT = 86;
const GROWTH_GRAPH_PLOT_RIGHT = 28;
const GROWTH_GRAPH_PLOT_TOP = 24;
const GROWTH_GRAPH_PLOT_BOTTOM = 52;
const GROWTH_GRAPH_PLOT_WIDTH = GROWTH_GRAPH_WIDTH - GROWTH_GRAPH_PLOT_LEFT - GROWTH_GRAPH_PLOT_RIGHT;
const GROWTH_GRAPH_PLOT_HEIGHT = GROWTH_GRAPH_HEIGHT - GROWTH_GRAPH_PLOT_TOP - GROWTH_GRAPH_PLOT_BOTTOM;
const GROWTH_GRAPH_MIN_X_SPAN = 0.1;
const GROWTH_GRAPH_MIN_Y_SPAN = 0.65;
const GROWTH_GRAPH_MAX_ZOOM = 10;
const GROWTH_GRAPH_ZOOM_STEP = 1.35;
const BOGO_MIN_ATTEMPTS = 1;
const BOGO_STANDARD_MAX_ATTEMPTS = 999_999_999;
// At the top end, the live runner works in short CPU batches. This is a
// deliberately conservative pre-run model; the page replaces it with the
// browser's measured rate once a Bogo session has run long enough to sample.
const BOGO_FAST_ESTIMATED_SHUFFLES_PER_SECOND = 2_500_000;
const BOGO_RATE_SAMPLE_INTERVAL = 250;
const BOGO_EXPECTED_RATE_FREEZE_AFTER = 2_500;
// A small buffer makes a direct block drop forgiving without swallowing the
// dedicated gap that sits between adjacent blocks.
const PRACTICE_DIRECT_DROP_HIT_SLOP = 8;
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
    case "pdq":
      return pattern === "nearly-sorted" ? 1.15 * n : 1.55 * n * logN;
    case "merge":
      return 2 * n * logN;
    case "powersort":
      return pattern === "nearly-sorted" ? 1.15 * n : 2.05 * n * logN;
  }
}

function getBogoExpectedShuffles(size: number) {
  let possibilities = 1;

  for (let value = 2; value <= size; value += 1) {
    possibilities *= value;
  }

  return possibilities;
}

function getCompletionSweepDuration(valueCount: number) {
  return Math.max(
    COMPLETION_SWEEP_MIN_DURATION,
    Math.max(valueCount, 1) * COMPLETION_SWEEP_MILLISECONDS_PER_BAR,
  );
}

function getPlaybackSpeed(speedPercent: number) {
  const clampedPercent = Math.min(DISPLAY_SPEED_MAX, Math.max(1, Math.round(speedPercent)));
  return Math.round(
    1 + ((clampedPercent - 1) * (MAX_SPEED - 1)) / (DISPLAY_SPEED_MAX - 1),
  );
}

function getBogoSlowMotionDelay(speed: number) {
  // Bogo already switches to its CPU-batched fast mode at 100. Speeds above
  // that point should not make a bogus negative delay or promise more than
  // the browser can actually shuffle.
  if (speed >= 100) return 0;
  return Math.round(440 * (1 - (speed - 1) / 99) ** 3);
}

function getBogoEstimatedShuffleRate(speed: number) {
  const slowMotionDelay = getBogoSlowMotionDelay(speed);

  if (slowMotionDelay > 0) {
    // Browsers commonly clamp nested timers to a few milliseconds, so do not
    // promise a faster rate than the scheduler can actually provide.
    return 1_000 / Math.max(slowMotionDelay, 4);
  }

  return BOGO_FAST_ESTIMATED_SHUFFLES_PER_SECOND;
}

function formatBogoShuffleEstimate(shuffles: number) {
  if (shuffles < 1_000_000) return Math.round(shuffles).toLocaleString("en-US");

  const exponent = Math.floor(Math.log10(shuffles));
  const leading = shuffles / 10 ** exponent;
  const digits = leading >= 100 ? 0 : leading >= 10 ? 1 : 2;
  return "≈ " + leading.toFixed(digits) + " × 10^" + exponent;
}

function formatBogoShuffleRate(shufflesPerSecond: number) {
  if (shufflesPerSecond >= 1_000_000) {
    const millions = shufflesPerSecond / 1_000_000;
    return (millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10) + " million shuffles/second";
  }

  return Math.max(1, Math.round(shufflesPerSecond)).toLocaleString("en-US") + " shuffles/second";
}

function formatBogoExpectedTime(shuffles: number, shufflesPerSecond: number) {
  const seconds = shuffles / Math.max(shufflesPerSecond, 1);
  if (seconds < 1) return "under a second";

  const units = [
    { seconds: 365.25 * 24 * 60 * 60, singular: "year", plural: "years" },
    { seconds: 24 * 60 * 60, singular: "day", plural: "days" },
    { seconds: 60 * 60, singular: "hour", plural: "hours" },
    { seconds: 60, singular: "minute", plural: "minutes" },
    { seconds: 1, singular: "second", plural: "seconds" },
  ];
  const unit = units.find((candidate) => seconds >= candidate.seconds) ?? units.at(-1)!;
  const amount = seconds / unit.seconds;
  const rounded =
    amount >= 100 ? Math.round(amount) : amount >= 10 ? Math.round(amount * 10) / 10 : Math.round(amount * 100) / 100;

  return rounded.toLocaleString("en-US") + " " + (rounded === 1 ? unit.singular : unit.plural);
}

function formatBogoElapsedTime(milliseconds: number) {
  const totalMilliseconds = Math.max(0, Math.round(milliseconds));

  if (totalMilliseconds < 60_000) {
    return (totalMilliseconds / 1_000).toFixed(3) + "s";
  }

  const totalSeconds = Math.floor(totalMilliseconds / 1_000);
  const millisecondsRemainder = totalMilliseconds % 1_000;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const secondsWithMilliseconds =
    String(seconds).padStart(2, "0") + "." + String(millisecondsRemainder).padStart(3, "0") + "s";

  if (days > 0) {
    return (
      days + "d " + String(hours).padStart(2, "0") + "h " +
      String(minutes).padStart(2, "0") + "m " + secondsWithMilliseconds
    );
  }
  if (hours > 0) {
    return hours + "h " + String(minutes).padStart(2, "0") + "m " + secondsWithMilliseconds;
  }
  return minutes + "m " + secondsWithMilliseconds;
}

type AlgorithmInsight = {
  title: string;
  copy: string;
};

type AlgorithmDetails = {
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
  benefits: AlgorithmInsight[];
  tradeoffs: AlgorithmInsight[];
  practice: PracticeStep[];
};

const ALGORITHM_DETAILS: Record<AlgorithmId, AlgorithmDetails> = {
  insertion: {
    label: "Insertion sort",
    number: "04",
    heroCopy: "Take the next value and slide it into its place inside the sorted left side.",
    controlTitle: "Insert the next value into place",
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
    benefits: [
      { title: "Excellent when nearly ordered", copy: "It leaves the sorted left side alone and shifts only the values that are genuinely out of place." },
      { title: "Small and stable", copy: "It works in the original row and keeps equal values in their original order." },
    ],
    tradeoffs: [
      { title: "Long slides add up", copy: "A small value near the end may have to travel past many earlier values." },
      { title: "Not for heavy disorder", copy: "A large shuffled row creates so many shifts that faster divide-and-conquer sorts usually win." },
    ],
    practice: [
      {
        prompt: "Use two swaps to carry the key, 1, left through the sorted prefix.",
        start: [2, 5, 1, 4, 3],
        target: [1, 2, 5, 4, 3],
        hint: "First move 1 past 5, then past 2. The prefix should read [1, 2, 5].",
      },
      {
        prompt: "Insert the next key, 4, into the prefix.",
        start: [1, 2, 5, 4, 3],
        target: [1, 2, 4, 5, 3],
        hint: "4 only needs to pass 5.",
      },
      {
        prompt: "Carry the last key, 3, left until the whole row is ordered.",
        start: [1, 2, 4, 5, 3],
        target: [1, 2, 3, 4, 5],
        hint: "Move 3 past 5, then past 4.",
      },
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
    benefits: [
      { title: "Very easy to follow", copy: "Every decision looks at neighbors, so each swap has an obvious local reason." },
      { title: "Can stop early", copy: "A pass with no swaps proves that an already ordered row is finished." },
    ],
    tradeoffs: [
      { title: "Big values move slowly", copy: "A value can travel only one seat at a time, which creates many repeated passes." },
      { title: "Poor at scale", copy: "On a large scrambled row it keeps revisiting nearly the same neighboring pairs." },
    ],
    practice: [
      {
        prompt: "Start the bubble by moving 1 ahead of 4.",
        start: [4, 1, 3, 2, 5],
        target: [1, 4, 3, 2, 5],
        hint: "The first pair is backwards: 4 is larger than 1.",
      },
      {
        prompt: "Keep 4 bubbling right past 3.",
        start: [1, 4, 3, 2, 5],
        target: [1, 3, 4, 2, 5],
        hint: "Compare the neighboring pair containing 4 and 3.",
      },
      {
        prompt: "Finish the first sweep by sending 4 past 2.",
        start: [1, 3, 4, 2, 5],
        target: [1, 3, 2, 4, 5],
        hint: "4 is still larger than the value beside it; 5 is already settled.",
      },
      {
        prompt: "Make the last neighboring swap to complete the five-value row.",
        start: [1, 3, 2, 4, 5],
        target: [1, 2, 3, 4, 5],
        hint: "Compare 3 and 2; the two rightmost values stay in place.",
      },
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
    benefits: [
      { title: "Helps both ends", copy: "The forward sweep pushes a large value right, and the return sweep lets a small value travel left immediately." },
      { title: "A useful stepping stone", copy: "It keeps Bubble Sort's simple neighbor rule while showing why direction can matter." },
    ],
    tradeoffs: [
      { title: "Still neighbor by neighbor", copy: "Even with the return trip, distant values move only one place per comparison." },
      { title: "Same big-picture cost", copy: "Two directions help some arrangements but do not remove the many passes on a large scrambled row." },
    ],
    practice: [
      {
        prompt: "Start the forward sweep by moving 1 ahead of 5.",
        start: [5, 1, 3, 2, 4],
        target: [1, 5, 3, 2, 4],
        hint: "The first neighboring pair is backwards.",
      },
      {
        prompt: "Keep 5 moving right past 3.",
        start: [1, 5, 3, 2, 4],
        target: [1, 3, 5, 2, 4],
        hint: "On a forward sweep, the larger neighbor keeps traveling right.",
      },
      {
        prompt: "Keep the forward sweep going past 2.",
        start: [1, 3, 5, 2, 4],
        target: [1, 3, 2, 5, 4],
        hint: "5 is still the large value in this neighboring pair.",
      },
      {
        prompt: "Settle 5 at the right edge to finish the forward sweep.",
        start: [1, 3, 2, 5, 4],
        target: [1, 3, 2, 4, 5],
        hint: "Swap the final backward neighboring pair in the forward direction.",
      },
      {
        prompt: "Now use the backward sweep to carry 2 left into place.",
        start: [1, 3, 2, 4, 5],
        target: [1, 2, 3, 4, 5],
        hint: "The return sweep fixes the small value that needs to travel left.",
      },
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
    benefits: [
      { title: "Few placements", copy: "It scans a lot, but normally makes only one final swap for each new sorted position." },
      { title: "Predictable", copy: "It does about the same amount of searching whether the row starts almost sorted or very scrambled." },
    ],
    tradeoffs: [
      { title: "Cannot take the easy win", copy: "It still searches the rest of the row even when the next value is already the smallest." },
      { title: "May disturb ties", copy: "A normal swap can change the order of equal-looking items that carry other information." },
    ],
    practice: [
      {
        prompt: "Scan the full row, then place the smallest value, 1, first.",
        start: [5, 4, 2, 1, 3],
        target: [1, 4, 2, 5, 3],
        hint: "Selection sort swaps the minimum, 1, with the first open position.",
      },
      {
        prompt: "From the remaining values, place 2 in the next open spot.",
        start: [1, 4, 2, 5, 3],
        target: [1, 2, 4, 5, 3],
        hint: "The finished 1 stays untouched while 2 moves into the second position.",
      },
      {
        prompt: "Find the next minimum, 3, and place it third.",
        start: [1, 2, 4, 5, 3],
        target: [1, 2, 3, 5, 4],
        hint: "Scan the unsorted tail before swapping 3 into the next open spot.",
      },
      {
        prompt: "Make the final selection swap to finish the row.",
        start: [1, 2, 3, 5, 4],
        target: [1, 2, 3, 4, 5],
        hint: "4 is now the smallest remaining value.",
      },
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
    benefits: [
      { title: "Reliable on any arrangement", copy: "The heap rule always exposes the largest remaining value, giving dependable performance on difficult rows." },
      { title: "Low extra memory", copy: "It reorganizes the original row instead of needing a second full output row." },
    ],
    tradeoffs: [
      { title: "Harder to read", copy: "The tree-shaped rule makes values jump in ways that are less intuitive than neighboring swaps or merges." },
      { title: "Does not preserve ties", copy: "Equal-looking items can change relative order as values are sifted through the heap." },
    ],
    practice: [
      {
        prompt: "Build the six-value max heap by moving 6 to the root.",
        start: [4, 6, 5, 2, 3, 1],
        target: [6, 4, 5, 2, 3, 1],
        hint: "The root must be at least as large as both of its children.",
      },
      {
        prompt: "Extract 6, then sift the new root down to restore the five-value heap.",
        start: [6, 4, 5, 2, 3, 1],
        target: [5, 4, 1, 2, 3, 6],
        hint: "First send 6 to the far right. Then move the larger child, 5, to the root.",
      },
      {
        prompt: "Extract 5 and restore the next smaller heap.",
        start: [5, 4, 1, 2, 3, 6],
        target: [4, 3, 1, 2, 5, 6],
        hint: "Send 5 beside 6, then sift 4 above the temporary root.",
      },
      {
        prompt: "Extract 4 and repair the three-value heap.",
        start: [4, 3, 1, 2, 5, 6],
        target: [3, 2, 1, 4, 5, 6],
        hint: "After 4 reaches its settled position, 3 should return to the root.",
      },
      {
        prompt: "Extract 3 and sift 2 back to the root.",
        start: [3, 2, 1, 4, 5, 6],
        target: [2, 1, 3, 4, 5, 6],
        hint: "The remaining two-value heap still needs its larger value on top.",
      },
      {
        prompt: "Extract 2 to complete the ordered six-value row.",
        start: [2, 1, 3, 4, 5, 6],
        target: [1, 2, 3, 4, 5, 6],
        hint: "The final two active values are a tiny max heap.",
      },
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
    benefits: [
      { title: "Usually very fast", copy: "A useful pivot breaks one big job into smaller independent jobs, so it often finishes quickly in practice." },
      { title: "Locks in progress", copy: "Once a pivot is placed, that exact value never has to move again." },
    ],
    tradeoffs: [
      { title: "Pivot choice matters", copy: "A poor pivot can keep creating lopsided pieces and make the sort do much more work." },
      { title: "Can look chaotic", copy: "Partition swaps may scramble the middle even while several pivots are already final." },
    ],
    practice: [
      {
        prompt: "Pivot 4 is parked on the right. Move the smaller value 1 into the first open spot on its left side.",
        start: [6, 1, 7, 3, 8, 2, 5, 4],
        target: [1, 6, 7, 3, 8, 2, 5, 4],
        pivot: 4,
        activeRange: [0, 7],
        settled: [],
        hint: "1 is no larger than pivot 4, so trade it with the first value, 6. Leave the highlighted pivot parked for now.",
      },
      {
        prompt: "Keep pivot 4 parked. Move 3 into the next open spot on its smaller-value side.",
        start: [1, 6, 7, 3, 8, 2, 5, 4],
        target: [1, 3, 7, 6, 8, 2, 5, 4],
        pivot: 4,
        activeRange: [0, 7],
        settled: [],
        hint: "3 also belongs before 4. Swap 3 with 6, the next value in the not-yet-partitioned area.",
      },
      {
        prompt: "There is one more smaller value for pivot 4: move 2 into the final open spot on its left.",
        start: [1, 3, 7, 6, 8, 2, 5, 4],
        target: [1, 3, 2, 6, 8, 7, 5, 4],
        pivot: 4,
        activeRange: [0, 7],
        settled: [],
        hint: "2 belongs before 4. It trades with 7 to finish the smaller-value side [1, 3, 2].",
      },
      {
        prompt: "Now place pivot 4 directly after its smaller-value side. Its position becomes permanent.",
        start: [1, 3, 2, 6, 8, 7, 5, 4],
        target: [1, 3, 2, 4, 8, 7, 5, 6],
        pivot: 4,
        activeRange: [0, 7],
        settled: [],
        hint: "Swap the highlighted pivot 4 with 6. Everything left of it is smaller; everything right is larger.",
      },
      {
        prompt: "A new smaller range opens on the left. Its new pivot is 2—place it between 1 and 3.",
        start: [1, 3, 2, 4, 8, 7, 5, 6],
        target: [1, 2, 3, 4, 8, 7, 5, 6],
        pivot: 2,
        activeRange: [0, 2],
        settled: [4],
        hint: "1 is already on pivot 2's smaller side. Swap the highlighted 2 with 3 to lock it in place.",
      },
      {
        prompt: "The left side is finished. In the right range, pivot 6 is parked on the right—move 5 to its smaller side.",
        start: [1, 2, 3, 4, 8, 7, 5, 6],
        target: [1, 2, 3, 4, 5, 7, 8, 6],
        pivot: 6,
        activeRange: [4, 7],
        settled: [1, 2, 3, 4],
        hint: "Only 5 is no larger than pivot 6. Swap 5 with the first active value, 8.",
      },
      {
        prompt: "Place pivot 6 immediately after 5. That locks the next pivot position.",
        start: [1, 2, 3, 4, 5, 7, 8, 6],
        target: [1, 2, 3, 4, 5, 6, 8, 7],
        pivot: 6,
        activeRange: [4, 7],
        settled: [1, 2, 3, 4, 5],
        hint: "Swap the highlighted pivot 6 with 7, the first value on its larger side.",
      },
      {
        prompt: "Only two values remain. The new pivot is 7; swap it into its final spot to finish the row.",
        start: [1, 2, 3, 4, 5, 6, 8, 7],
        target: [1, 2, 3, 4, 5, 6, 7, 8],
        pivot: 7,
        activeRange: [6, 7],
        settled: [1, 2, 3, 4, 5, 6],
        hint: "7 is the pivot for this final pair. Swap it with 8 to finish Quick Sort.",
      },
    ],
  },
  pdq: {
    label: "PDQ sort",
    number: "08",
    heroCopy: "Use smarter pivots, spot easy patterns, and keep Quick Sort's speed without its nasty worst-case surprise.",
    controlTitle: "Defeat awkward patterns",
    stageLabel: "adaptive partition",
    stageDescription: "pivot choice and safety check",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Quick Sort with a better escape plan.",
    learnCopy: [
      "PDQ sort stands for pattern-defeating quicksort. Like Quick Sort, it divides a row around a pivot. The difference is that it watches for warning signs: a lopsided split, a row that is already almost ordered, or a repeating pattern that keeps tricking ordinary pivots.",
      "When a partition looks healthy, PDQ sort keeps the fast Quick Sort rhythm. When it sees trouble, it changes a few positions to break the pattern, uses tiny insertion-sort cleanups for short pieces, and has a Heap Sort safety fallback. It is designed to be quick in everyday data without risking Quick Sort's familiar worst-case slowdown.",
    ],
    complexity: ["BEST O(n)", "AVERAGE O(n log n)", "WORST O(n log n)"],
    cardTitle: "PDQ SORT",
    cardTag: "adaptive · in-place",
    steps: [
      "Pick a safer pivot from a small sample instead of trusting one edge value.",
      "Partition values smaller and larger than that pivot, watching whether the split is balanced.",
      "Use a small-piece cleanup or a Heap Sort fallback only when the row needs it.",
    ],
    examples: [
      { values: "[8, 1, 7, 3, 6, 2, 5, 4]", detail: "A small sample helps choose a pivot near the middle instead of blindly using an awkward edge value." },
      { values: "[1, 3, 2 | 4 | 8, 7, 6, 5]", detail: "A healthy pivot makes two smaller jobs. PDQ sort keeps using fast partitions when that happens." },
      { values: "bad split → pattern break / heap backup", detail: "If one side keeps swallowing nearly everything, it changes course instead of letting the slow case grow." },
    ],
    benefits: [
      { title: "Fast on real-looking data", copy: "It is built to recognize ordered stretches and avoid doing the same work again when a row is already close to sorted." },
      { title: "Quick Sort with a safety net", copy: "Its fallback prevents a few unlucky pivots from turning a large job into the painfully slow version of Quick Sort." },
    ],
    tradeoffs: [
      { title: "More moving parts", copy: "The checks, pivot sampling, and backup plan make it harder to explain than basic Quick Sort even though the core partition idea is the same." },
      { title: "Not stable", copy: "Values with the same height can trade places during partitions, so it is not the right pick when their original order matters too." },
    ],
    practice: [
      {
        prompt: "Use a middle-looking pivot strategy: begin by moving 1 into the small side of this eight-value row.",
        start: [8, 1, 7, 3, 6, 2, 5, 4],
        target: [1, 8, 7, 3, 6, 2, 5, 4],
        hint: "A safe pivot still needs smaller values grouped on its left. Start with the obvious small value, 1.",
      },
      {
        prompt: "Keep building a balanced smaller side by moving 2 beside 1.",
        start: [1, 8, 7, 3, 6, 2, 5, 4],
        target: [1, 2, 7, 3, 6, 8, 5, 4],
        hint: "This is the same partition rule as Quick Sort: move a value only when it belongs on this side of the pivot.",
      },
      {
        prompt: "Finish this miniature adaptive partition into a clean ordered row.",
        start: [1, 2, 7, 3, 6, 8, 5, 4],
        target: [1, 2, 3, 4, 5, 6, 7, 8],
        hint: "Use helpful swaps only. PDQ sort lets small, nearly ordered pieces finish with a simple cleanup.",
      },
    ],
  },
  merge: {
    label: "Merge sort",
    number: "09",
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
    benefits: [
      { title: "Dependable speed", copy: "It combines ordered pieces in a steady pattern, so a sorted or reverse row does not surprise it with a slowdown." },
      { title: "Keeps ties in order", copy: "When equal values meet, it can retain their original order—useful when values carry labels too." },
    ],
    tradeoffs: [
      { title: "Needs workspace", copy: "It builds temporary merged runs, so a large sort needs another row's worth of working memory." },
      { title: "Planned passes still happen", copy: "It does not get as much of a free win from an almost sorted row as a highly adaptive sort can." },
    ],
    practice: [
      {
        prompt: "Sort the first one-value pair into the run [1, 5].",
        start: [5, 1, 6, 2, 7, 3, 8, 4],
        target: [1, 5, 6, 2, 7, 3, 8, 4],
        hint: "Each one-value run is already ordered; write the smaller front value first.",
        groups: [
          { range: [0, 1], label: "working pair", detail: "turn these two one-value runs into one ordered run", tone: "cyan", active: true },
          { range: [2, 3], label: "next pair", detail: "leave this pair for its own merge", tone: "violet" },
          { range: [4, 5], label: "next pair", detail: "leave this pair for its own merge", tone: "mint" },
          { range: [6, 7], label: "next pair", detail: "leave this pair for its own merge", tone: "gold" },
        ],
      },
      {
        prompt: "Sort the second pair into [2, 6].",
        start: [1, 5, 6, 2, 7, 3, 8, 4],
        target: [1, 5, 2, 6, 7, 3, 8, 4],
        hint: "Keep the first completed run [1, 5] untouched.",
        groups: [
          { range: [0, 1], label: "ready run", detail: "this pair is already ordered", tone: "cyan" },
          { range: [2, 3], label: "working pair", detail: "turn these two one-value runs into one ordered run", tone: "violet", active: true },
          { range: [4, 5], label: "next pair", detail: "leave this pair for its own merge", tone: "mint" },
          { range: [6, 7], label: "next pair", detail: "leave this pair for its own merge", tone: "gold" },
        ],
      },
      {
        prompt: "Sort the third pair into [3, 7].",
        start: [1, 5, 2, 6, 7, 3, 8, 4],
        target: [1, 5, 2, 6, 3, 7, 8, 4],
        hint: "Only the third neighboring pair needs to change.",
        groups: [
          { range: [0, 1], label: "ready run", detail: "this pair is already ordered", tone: "cyan" },
          { range: [2, 3], label: "ready run", detail: "this pair is already ordered", tone: "violet" },
          { range: [4, 5], label: "working pair", detail: "turn these two one-value runs into one ordered run", tone: "mint", active: true },
          { range: [6, 7], label: "next pair", detail: "leave this pair for its own merge", tone: "gold" },
        ],
      },
      {
        prompt: "Sort the final pair into [4, 8].",
        start: [1, 5, 2, 6, 3, 7, 8, 4],
        target: [1, 5, 2, 6, 3, 7, 4, 8],
        hint: "After this, all four two-value runs are ordered.",
        groups: [
          { range: [0, 1], label: "ready run", detail: "this pair is already ordered", tone: "cyan" },
          { range: [2, 3], label: "ready run", detail: "this pair is already ordered", tone: "violet" },
          { range: [4, 5], label: "ready run", detail: "this pair is already ordered", tone: "mint" },
          { range: [6, 7], label: "working pair", detail: "turn these two one-value runs into one ordered run", tone: "gold", active: true },
        ],
      },
      {
        prompt: "Merge [1, 5] with [2, 6] into one four-value run.",
        start: [1, 5, 2, 6, 3, 7, 4, 8],
        target: [1, 2, 5, 6, 3, 7, 4, 8],
        hint: "2 is the next smallest front value, so it belongs before 5.",
        groups: [
          { range: [0, 1], label: "left run", detail: "take the next smallest front value from this run", tone: "cyan", active: true },
          { range: [2, 3], label: "right run", detail: "take the next smallest front value from this run", tone: "violet", active: true },
          { range: [4, 5], label: "waiting run", detail: "this pair merges in the next step", tone: "mint" },
          { range: [6, 7], label: "waiting run", detail: "this pair merges in the next step", tone: "gold" },
        ],
      },
      {
        prompt: "Merge [3, 7] with [4, 8] into the other four-value run.",
        start: [1, 2, 5, 6, 3, 7, 4, 8],
        target: [1, 2, 5, 6, 3, 4, 7, 8],
        hint: "4 needs to come before 7 while the completed left run stays untouched.",
        groups: [
          { range: [0, 3], label: "ready four-value run", detail: "this merged run is already in order", tone: "cyan" },
          { range: [4, 5], label: "left run", detail: "take the next smallest front value from this run", tone: "mint", active: true },
          { range: [6, 7], label: "right run", detail: "take the next smallest front value from this run", tone: "gold", active: true },
        ],
      },
      {
        prompt: "Complete the final merge of the two ordered four-value runs.",
        start: [1, 2, 5, 6, 3, 4, 7, 8],
        target: [1, 2, 3, 4, 5, 6, 7, 8],
        hint: "Bring 3 and then 4 left through [5, 6]. Each helpful swap remains on the board.",
        groups: [
          { range: [0, 3], label: "left four-value run", detail: "compare its next front value with the other run", tone: "cyan", active: true },
          { range: [4, 7], label: "right four-value run", detail: "compare its next front value with the other run", tone: "violet", active: true },
        ],
      },
    ],
  },
  powersort: {
    label: "Powersort",
    number: "10",
    heroCopy: "Notice the stretches already in order, then merge them in a carefully chosen order that wastes less work.",
    controlTitle: "Merge the runs that matter",
    stageLabel: "run decision",
    stageDescription: "natural runs and merge order",
    eyebrow: "THE BIG IDEA",
    learnTitle: "Build from the order that is already there.",
    learnCopy: [
      "Powersort begins by looking for natural runs: short stretches that are already rising, or falling stretches that can be turned around. Real data often contains these little pieces of order, even when the full row is not sorted.",
      "Instead of merging runs in a fixed left-to-right schedule, Powersort calculates how important each boundary is in a balanced merge tree. That lets it combine nearby runs in an order that keeps the total amount of copying close to the best possible for the runs it found.",
    ],
    complexity: ["BEST O(n)", "WORST O(n log n)", "STABLE YES"],
    cardTitle: "POWERSORT",
    cardTag: "adaptive · stable",
    steps: [
      "Scan for rising runs and flip any strictly falling run into rising order.",
      "Measure each boundary's merge priority, called its power.",
      "Merge runs in that priority order until one stable sorted run remains.",
    ],
    examples: [
      { values: "[1, 4, 7] [2, 5, 8] [3, 6, 9]", detail: "These are already three rising runs, so Powersort can reuse that work instead of starting from single values." },
      { values: "run boundary → power", detail: "A boundary's power describes where its runs belong in a balanced merge plan." },
      { values: "[1, 2, 3, 4, 5, 6, 7, 8, 9]", detail: "Stable merging preserves the order of tied values while the natural runs become one row." },
    ],
    benefits: [
      { title: "Excellent at partly ordered data", copy: "It gets a real shortcut when the input already contains long rising or falling stretches, which is common outside textbook random data." },
      { title: "Stable and carefully scheduled", copy: "Equal values stay in their original order, while its merge plan avoids many unnecessary extra moves." },
    ],
    tradeoffs: [
      { title: "Uses extra workspace", copy: "Like other merge-based sorts, it needs temporary room while it combines two runs." },
      { title: "The merge plan is abstract", copy: "The idea of a boundary power is less intuitive than a simple swap or pivot, so the visualizer exposes each run and merge decision." },
    ],
    practice: [
      {
        prompt: "Turn the first falling pair into the rising run [1, 5].",
        start: [5, 1, 6, 2, 7, 3, 8, 4],
        target: [1, 5, 6, 2, 7, 3, 8, 4],
        hint: "Powersort begins by spotting a run that is already easy to make increasing.",
        groups: [
          { range: [0, 1], label: "falling run", detail: "reverse this short run so it rises", tone: "gold", active: true },
          { range: [2, 3], label: "next run", detail: "this short run will be prepared next", tone: "violet" },
          { range: [4, 5], label: "later run", detail: "keep this boundary visible for the merge plan", tone: "mint" },
          { range: [6, 7], label: "later run", detail: "keep this boundary visible for the merge plan", tone: "cyan" },
        ],
      },
      {
        prompt: "Make the next two-value rising run [2, 6].",
        start: [1, 5, 6, 2, 7, 3, 8, 4],
        target: [1, 5, 2, 6, 7, 3, 8, 4],
        hint: "Leave the run [1, 5] alone while you prepare the next run." ,
        groups: [
          { range: [0, 1], label: "ready run", detail: "Powersort can reuse this order", tone: "gold" },
          { range: [2, 3], label: "falling run", detail: "reverse this short run so it rises", tone: "violet", active: true },
          { range: [4, 5], label: "later run", detail: "keep this boundary visible for the merge plan", tone: "mint" },
          { range: [6, 7], label: "later run", detail: "keep this boundary visible for the merge plan", tone: "cyan" },
        ],
      },
      {
        prompt: "Use the discovered runs to finish the stable merge.",
        start: [1, 5, 2, 6, 7, 3, 8, 4],
        target: [1, 2, 3, 4, 5, 6, 7, 8],
        hint: "Bring the smallest available front value forward each time; the runs give you a head start.",
        groups: [
          { range: [0, 1], label: "ready run", detail: "this discovered run already rises", tone: "gold", active: true },
          { range: [2, 3], label: "ready run", detail: "this discovered run already rises", tone: "violet", active: true },
          { range: [4, 5], label: "run to merge", detail: "use its smallest available value when it belongs next", tone: "mint", active: true },
          { range: [6, 7], label: "run to merge", detail: "use its smallest available value when it belongs next", tone: "cyan", active: true },
        ],
      },
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
    benefits: [
      { title: "Makes randomness visible", copy: "Its whole rule is shuffle, check, repeat, so it makes clear why useful sorting needs a plan." },
      { title: "Fine for a tiny experiment", copy: "On a few values it is a memorable way to see how quickly the number of possible orders explodes." },
    ],
    tradeoffs: [
      { title: "Throws progress away", copy: "A failed shuffle keeps no useful part of the previous order; it starts the whole guess over." },
      { title: "Usually cannot finish", copy: "The odds become tiny so quickly that the safety cap will normally stop a larger example before luck does." },
    ],
    practice: [
      {
        prompt: "For this tiny example, arrange the lucky sorted shuffle.",
        start: [3, 1, 2],
        target: [1, 2, 3],
        hint: "Bogo has no smarter move—you are just modeling the lucky outcome one swap at a time.",
      },
      {
        prompt: "Try a second tiny lucky outcome with four values.",
        start: [2, 4, 1, 3],
        target: [1, 2, 3, 4],
        hint: "There is only one successful order among all possible shuffles.",
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

function arraysMatch(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getPracticeGroupAtIndex(groups: PracticeGroup[], index: number) {
  return groups.find((group) => index >= group.range[0] && index <= group.range[1]);
}

// Every hands-on lesson uses a complete, consecutive set of values. Small
// legacy examples are extended with already-visible trailing values so even a
// first lesson has enough blocks to feel like a real little array, while the
// more involved lessons remain comfortably below ten blocks.
function normalizePracticeSteps(steps: PracticeStep[]): PracticeStep[] {
  return steps.map((step) => {
    const largestValue = Math.max(...step.start, ...step.target, 1);
    const blockCount = Math.min(10, Math.max(6, largestValue));
    const completeRow = (values: number[]) => {
      const nextValues = [...values];
      for (let value = 1; value <= blockCount; value += 1) {
        if (!nextValues.includes(value)) nextValues.push(value);
      }
      return nextValues;
    };

    return {
      ...step,
      start: completeRow(step.start),
      target: completeRow(step.target),
    };
  });
}

function formatCount(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

function formatGrowthSize(value: number) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2).replace(/\.00$/, "") + "m";
  if (value >= 1_000) return Math.round(value / 1_000) + "k";
  return String(value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function getGrowthViewport(domain: GrowthGraphDomain, view: GrowthView): GrowthViewport {
  const maximumZoom = Math.max(
    1,
    Math.min(
      GROWTH_GRAPH_MAX_ZOOM,
      1 / GROWTH_GRAPH_MIN_X_SPAN,
      domain.exponentSpan / GROWTH_GRAPH_MIN_Y_SPAN,
    ),
  );
  const zoom = clamp(view.zoom, 1, maximumZoom);
  const xSpan = Math.max(GROWTH_GRAPH_MIN_X_SPAN, 1 / zoom);
  const ySpan = Math.max(GROWTH_GRAPH_MIN_Y_SPAN, domain.exponentSpan / zoom);
  const centerX = clamp(view.centerX, xSpan / 2, 1 - xSpan / 2);
  const centerY = clamp(
    view.centerY,
    domain.minimumExponent + ySpan / 2,
    domain.maximumExponent - ySpan / 2,
  );

  return {
    ...domain,
    zoom,
    xStart: centerX - xSpan / 2,
    xEnd: centerX + xSpan / 2,
    xSpan,
    yMinimum: centerY - ySpan / 2,
    yMaximum: centerY + ySpan / 2,
    ySpan,
  };
}

function normalizeGrowthView(domain: GrowthGraphDomain, view: GrowthView): GrowthView {
  const viewport = getGrowthViewport(domain, view);
  return {
    zoom: viewport.zoom,
    centerX: (viewport.xStart + viewport.xEnd) / 2,
    centerY: (viewport.yMinimum + viewport.yMaximum) / 2,
  };
}

function zoomGrowthView(
  domain: GrowthGraphDomain,
  view: GrowthView,
  multiplier: number,
  focusX?: number,
  focusY?: number,
): GrowthView {
  const viewport = getGrowthViewport(domain, view);
  const maximumZoom = Math.max(
    1,
    Math.min(
      GROWTH_GRAPH_MAX_ZOOM,
      1 / GROWTH_GRAPH_MIN_X_SPAN,
      domain.exponentSpan / GROWTH_GRAPH_MIN_Y_SPAN,
    ),
  );
  const zoom = clamp(viewport.zoom * multiplier, 1, maximumZoom);
  const zoomedViewport = getGrowthViewport(domain, { ...view, zoom });
  const pinnedX = focusX ?? (viewport.xStart + viewport.xEnd) / 2;
  const pinnedY = focusY ?? (viewport.yMinimum + viewport.yMaximum) / 2;
  const xRatio = clamp((pinnedX - viewport.xStart) / viewport.xSpan, 0, 1);
  const yRatio = clamp((viewport.yMaximum - pinnedY) / viewport.ySpan, 0, 1);

  return normalizeGrowthView(domain, {
    zoom,
    centerX: pinnedX + (0.5 - xRatio) * zoomedViewport.xSpan,
    centerY: pinnedY + (yRatio - 0.5) * zoomedViewport.ySpan,
  });
}

function panGrowthView(
  domain: GrowthGraphDomain,
  view: GrowthView,
  deltaX: number,
  deltaY: number,
): GrowthView {
  const viewport = getGrowthViewport(domain, view);
  return normalizeGrowthView(domain, {
    ...view,
    centerX: (viewport.xStart + viewport.xEnd) / 2 - (deltaX / GROWTH_GRAPH_PLOT_WIDTH) * viewport.xSpan,
    centerY: (viewport.yMinimum + viewport.yMaximum) / 2 + (deltaY / GROWTH_GRAPH_PLOT_HEIGHT) * viewport.ySpan,
  });
}

function formatGrowthMultiplier(value: number) {
  if (value >= 100) return Math.round(value).toLocaleString("en-US") + "×";
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, "") + "×";
  return value.toFixed(2).replace(/0$/, "").replace(/\.$/, "") + "×";
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
    // `values` intentionally keeps the copied value at the key's old slot
    // while a real insertion pass shifts items right. Keep the visual hole
    // alongside that working representation so a following compare frame can
    // draw the held key there instead of momentarily showing a duplicate.
    let heldKeyGapIndex: number | null = null;

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
          gapIndex: heldKeyGapIndex,
          sortedCount: i,
          comparisons,
          writes,
          message: "Compare " + key + " with " + values[j] + ".",
        });
      }

      if (values[j] <= key) break;

      values[j + 1] = values[j];
      writes += 1;
      heldKeyGapIndex = j;
      if (!useCompactFrames) {
        steps.push({
          values: [...values],
          pass: i,
          phase: "shift",
          key,
          comparing: j,
          shifting: j + 1,
          inserting: null,
          gapIndex: heldKeyGapIndex,
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
  if (algorithm === "bogo") {
    if (step.phase === "complete") return "bar--sorted";
    if (step.phase === "limited") return "bar--limited";
    if (step.phase === "shuffle") return "bar--shuffle";
    return "bar--idle";
  }

  if (algorithm === "quick" || algorithm === "pdq") {
    if (step.phase === "complete") return "bar--sorted";
    // A settled pivot is in its final index. Keep that proof visible at every
    // array size while the active pivot and swaps show the current partition.
    if (step.settled?.includes(index) || step.visualSettled?.includes(index)) {
      return "bar--sorted";
    }
    if (step.phase === "select" && index === step.inserting) return "bar--key";
    if (
      algorithm === "pdq" &&
      step.phase === "heapify" &&
      step.rangeStart !== undefined &&
      step.rangeEnd !== undefined &&
      index >= step.rangeStart &&
      index < step.rangeEnd
    ) {
      return "bar--heap";
    }
    if (step.phase === "swap" && (index === step.comparing || index === step.shifting)) {
      return "bar--swap";
    }
    if (index === step.comparing) return "bar--compare";
    if (index === step.shifting) return "bar--shift";
    if (index === step.inserting) return "bar--insert";
    return "bar--idle";
  }

  if (algorithm === "merge" || algorithm === "powersort") {
    if (step.phase === "complete") return "bar--sorted";
    if (index === step.comparing || index === step.shifting) return "bar--compare";
    if (index === step.inserting) return "bar--insert";
    if (
      algorithm === "powersort" &&
      step.phase === "run" &&
      step.rangeStart !== undefined &&
      step.rangeEnd !== undefined &&
      index >= step.rangeStart &&
      index < step.rangeEnd
    ) {
      return "bar--run";
    }
    if (
      algorithm === "powersort" &&
      step.phase === "power" &&
      step.rangeStart !== undefined &&
      step.rangeEnd !== undefined &&
      index >= step.rangeStart &&
      index < step.rangeEnd
    ) {
      return "bar--power";
    }
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

type RenderedBarItem = {
  value: number;
  token: string;
  isGap: boolean;
};

function getRenderedBarItems(step: SortStep): RenderedBarItem[] {
  const occurrences = new Map<number, number>();

  return step.values.map((value, index) => {
    const isGap = index === step.gapIndex && step.key !== null;
    const shownValue = isGap ? step.key! : value;
    const occurrence = occurrences.get(shownValue) ?? 0;
    occurrences.set(shownValue, occurrence + 1);

    return {
      value: shownValue,
      token: String(shownValue) + ":" + String(occurrence),
      isGap,
    };
  });
}

function haveSameBarTokens(left: RenderedBarItem[], right: RenderedBarItem[]) {
  if (left.length !== right.length) return false;
  const rightTokens = new Set(right.map((item) => item.token));
  return left.every((item) => rightTokens.has(item.token));
}

function getPhaseLabel(phase: StepPhase) {
  const labels: Record<StepPhase, string> = {
    ready: "Ready",
    select: "Select key",
    compare: "Compare",
    shift: "Shift right",
    insert: "Insert key",
    split: "Start merge pass",
    swap: "Swap values",
    sweep: "Sweep",
    heapify: "Restore heap",
    merge: "Merge runs",
    run: "Find a natural run",
    power: "Schedule merge",
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
  // The runner should react to every speed input immediately, but the FLIP
  // animation must not repeatedly switch its DOM/keying strategy while a
  // range thumb is crossing the interpolation threshold.
  const [isAdjustingSpeedControl, setIsAdjustingSpeedControl] = useState(false);
  const [settledVisualSpeed, setSettledVisualSpeed] = useState(DEFAULT_SPEED);
  const [bogoAttemptLimit, setBogoAttemptLimit] = useState(BOGO_MAX_ATTEMPTS);
  const [bogoAttemptInput, setBogoAttemptInput] = useState(String(BOGO_MAX_ATTEMPTS));
  const [bogoRunsUntilSolved, setBogoRunsUntilSolved] = useState(false);
  const [benchmarkPattern, setBenchmarkPattern] =
    useState<BenchmarkPattern>("random");
  const [benchmarkTab, setBenchmarkTab] = useState<BenchmarkTab>("table");
  const [visibleGrowthAlgorithms, setVisibleGrowthAlgorithms] = useState(
    () => ({ ...DEFAULT_GROWTH_ALGORITHM_VISIBILITY }),
  );
  const [growthFocusedAlgorithm, setGrowthFocusedAlgorithm] = useState<BenchmarkAlgorithm | "all">("all");
  const [growthView, setGrowthView] = useState<GrowthView>({
    zoom: 1,
    centerX: 0.5,
    centerY: 0,
  });
  const [growthInspectionIndex, setGrowthInspectionIndex] = useState(0);
  const [growthHoverIndex, setGrowthHoverIndex] = useState<number | null>(null);
  const [isGrowthPanning, setIsGrowthPanning] = useState(false);
  const [originalValues, setOriginalValues] = useState(INITIAL_VALUES);
  const [values, setValues] = useState(INITIAL_VALUES);
  const [steps, setSteps] = useState<SortStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [runState, setRunState] = useState<RunState>("ready");
  const [bogoLiveStep, setBogoLiveStep] = useState<SortStep | null>(null);
  const [bogoMeasuredShuffleRate, setBogoMeasuredShuffleRate] = useState<number | null>(null);
  const [bogoFrozenExpectedShuffleRate, setBogoFrozenExpectedShuffleRate] = useState<number | null>(null);
  const [bogoExpectedRateSource, setBogoExpectedRateSource] = useState<
    "calibrating" | "measured" | "modeled"
  >("calibrating");
  const [bogoElapsedMilliseconds, setBogoElapsedMilliseconds] = useState(0);
  const [bogoCelebrationPhase, setBogoCelebrationPhase] = useState<
    "hidden" | "visible" | "fading"
  >("hidden");
  const [completionSweepActive, setCompletionSweepActive] = useState(false);
  const [soundVolume, setSoundVolume] = useState(50);
  const [practiceStepIndex, setPracticeStepIndex] = useState(0);
  const [practiceValues, setPracticeValues] = useState(
    () => [...normalizePracticeSteps(ALGORITHM_DETAILS.insertion.practice)[0].start],
  );
  const [practiceSelectedIndex, setPracticeSelectedIndex] = useState<number | null>(null);
  const [practiceDragIndex, setPracticeDragIndex] = useState<number | null>(null);
  const [practiceDraggingId, setPracticeDraggingId] = useState<string | null>(null);
  const [practiceDragOffset, setPracticeDragOffset] = useState({ x: 0, y: 0 });
  const [practiceDropIndex, setPracticeDropIndex] = useState<number | null>(null);
  const [practiceDropMode, setPracticeDropMode] = useState<PracticeDropMode | null>(null);
  const [practiceSolved, setPracticeSolved] = useState(false);
  const [practiceFeedback, setPracticeFeedback] = useState<string | null>(null);
  const [practiceUndoPending, setPracticeUndoPending] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const speedRef = useRef(speed);
  const soundVolumeRef = useRef(soundVolume);
  const lastToneTimeRef = useRef(0);
  const lastBogoTextureTimeRef = useRef(0);
  const completionSweepStartedRef = useRef(false);
  const completionSweepStartTimerRef = useRef<number | null>(null);
  const completionSweepEndTimerRef = useRef<number | null>(null);
  const completionSweepRunRef = useRef(0);
  const completionSweepSourcesRef = useRef(new Set<OscillatorNode>());
  const motionBarElementsRef = useRef(new Map<string, HTMLDivElement>());
  const motionBarPositionsRef = useRef(new Map<string, number>());
  const motionBarTokensRef = useRef<string[]>([]);
  const practiceBoardRef = useRef<HTMLDivElement | null>(null);
  const practiceBlockElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const practiceBlockPositionsRef = useRef(new Map<string, { left: number; top: number }>());
  const practicePointerRef = useRef<{
    id: string;
    fromIndex: number;
    pointerId: number;
    startX: number;
    startY: number;
    anchorX: number;
    anchorY: number;
    sourceOrigin: PracticeDropRegion;
    moved: boolean;
  } | null>(null);
  // State paints the highlighted target, while this ref preserves the latest
  // pointer location for the in-flight drag. Release still rechecks the live
  // geometry, so an old highlight can never become an accidental destination.
  const practiceDropTargetRef = useRef<PracticeDropTarget | null>(null);
  const suppressPracticeClickRef = useRef(false);
  const practiceClickSuppressionTimerRef = useRef<number | null>(null);
  const practiceUndoTimerRef = useRef<number | null>(null);
  const practiceAdvanceTimerRef = useRef<number | null>(null);
  const growthPanRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    view: GrowthView;
    moved: boolean;
  } | null>(null);
  const bogoSessionRef = useRef<BogoSession | null>(null);
  const bogoRateSampleRef = useRef<{
    startedAt: number;
    startingAttempts: number;
    lastReportedAt: number;
  } | null>(null);
  const bogoElapsedTimerRef = useRef<{
    accumulatedMilliseconds: number;
    startedAt: number | null;
    generation: number;
  }>({
    accumulatedMilliseconds: 0,
    startedAt: null,
    generation: 0,
  });
  const bogoExpectedRateSampleRef = useRef<{
    startingAttempts: number;
    startingElapsedMilliseconds: number;
    modeledShuffleRate: number;
    finalized: boolean;
  } | null>(null);
  const [motionSlideOffsets, setMotionSlideOffsets] = useState<Record<string, number>>({});
  const [motionSlideStage, setMotionSlideStage] = useState<"idle" | "prepare" | "animate">("idle");
  speedRef.current = speed;
  soundVolumeRef.current = soundVolume;
  const prefersReducedMotion = usePrefersReducedMotion();
  const isBogo = algorithm === "bogo";
  const playbackSpeed = isBogo ? speed : getPlaybackSpeed(speed);
  const smallArrayPianoToneMap = useMemo(
    () => createSmallArrayPianoToneMap(originalValues),
    [originalValues],
  );
  // While a control is being adjusted, keep the visual interpolation policy
  // at the last settled speed. Playback timing continues to use `speed`, so
  // the sort still reacts live without remounting bars at the 75% boundary.
  const interpolationSpeed = isAdjustingSpeedControl ? settledVisualSpeed : speed;
  const bogoAttemptMaximum = BOGO_STANDARD_MAX_ATTEMPTS;
  const bogoSliderStep = 1;
  const bogoExpectedShuffles = isBogo ? getBogoExpectedShuffles(arraySize) : 0;
  const bogoModeledShuffleRate = isBogo ? getBogoEstimatedShuffleRate(speed) : 0;
  const bogoExpectedShuffleRate =
    bogoFrozenExpectedShuffleRate ?? bogoMeasuredShuffleRate ?? bogoModeledShuffleRate;
  const bogoExpectedTime = isBogo
    ? formatBogoExpectedTime(bogoExpectedShuffles, bogoExpectedShuffleRate)
    : "";
  const bogoExpectedMilliseconds = isBogo
    ? (bogoExpectedShuffles / Math.max(bogoExpectedShuffleRate, 1)) * 1_000
    : 0;
  const bogoAverageProgress = isBogo
    ? bogoElapsedMilliseconds / Math.max(bogoExpectedMilliseconds, 1)
    : 0;
  const bogoTimerTone =
    bogoAverageProgress > 1 ? "over" : bogoAverageProgress > 0.5 ? "on-track" : "lucky";
  const bogoTimerRangeStatus =
    bogoTimerTone === "over"
      ? "Past the expected average"
      : bogoTimerTone === "on-track"
        ? "Within the expected average"
        : "Lucky — under half the expected average";
  const bogoTimerStatus =
    runState === "ready"
      ? "Ready — lucky range is under half the average"
      : runState === "paused"
        ? bogoTimerRangeStatus + " — paused"
        : bogoTimerRangeStatus;
  const soundEnabled = soundVolume > 0;
  const algorithmDetails = ALGORITHM_DETAILS[algorithm];
  const practiceSteps = useMemo(
    () => normalizePracticeSteps(algorithmDetails.practice),
    [algorithmDetails.practice],
  );
  const practiceFinished = practiceStepIndex >= practiceSteps.length;
  const currentPractice = practiceSteps[Math.min(practiceStepIndex, practiceSteps.length - 1)];
  const isQuickPractice = algorithm === "quick" && currentPractice.pivot !== undefined;
  const quickPivot = isQuickPractice ? currentPractice.pivot ?? null : null;
  const quickActiveRange = isQuickPractice ? currentPractice.activeRange : undefined;
  const quickSettledValues = isQuickPractice ? currentPractice.settled ?? [] : [];
  // Merge-family lessons use these position-based ranges to make the already
  // ordered runs visually explicit without changing the board's drag geometry.
  const practiceGroups = practiceFinished ? [] : currentPractice.groups ?? [];
  const algorithmLabel = algorithmDetails.label;
  const stageLabel = algorithmDetails.stageLabel;
  const totalStages = isBogo
    ? bogoRunsUntilSolved
      ? null
      : bogoAttemptLimit
    : algorithm === "merge"
      ? Math.max(1, Math.ceil(Math.log2(Math.max(originalValues.length, 1))))
      : algorithm === "heap"
        ? Math.max(1, originalValues.length)
        : Math.max(originalValues.length - 1, 0);
  const minimumArraySize = 4;
  const maximumArraySize = isBogo ? BOGO_MAX_ARRAY_SIZE : 256;
  const maximumSpeed = DISPLAY_SPEED_MAX;
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
  const orderedBenchmarkAlgorithms = useMemo(() => {
    const finalColumn = theoreticalBenchmarkData.at(-1)?.work;

    return [...BENCHMARK_ALGORITHMS].sort((left, right) => {
      const difference = (finalColumn?.[right.key] ?? 0) - (finalColumn?.[left.key] ?? 0);
      return difference || BENCHMARK_ALGORITHMS.indexOf(left) - BENCHMARK_ALGORITHMS.indexOf(right);
    });
  }, [theoreticalBenchmarkData]);
  const benchmarkMatrixStyle = {
    "--benchmark-columns": theoreticalBenchmarkData.length,
    minWidth: String(180 + theoreticalBenchmarkData.length * 118) + "px",
  } as CSSProperties;
  const growthGraphDomain = useMemo<GrowthGraphDomain>(() => {
    const modeledValues = theoreticalBenchmarkData.flatMap((entry) => Object.values(entry.work));
    const minimumExponent = Math.floor(Math.log10(Math.max(1, Math.min(...modeledValues))));
    const maximumExponent = Math.ceil(Math.log10(Math.max(...modeledValues)));
    return { minimumExponent, maximumExponent, exponentSpan: Math.max(1, maximumExponent - minimumExponent) };
  }, [theoreticalBenchmarkData]);
  const growthViewport = useMemo(
    () => getGrowthViewport(growthGraphDomain, growthView),
    [growthGraphDomain, growthView],
  );
  const growthGraphTicks = useMemo(
    () =>
      Array.from({ length: 5 }, (_, index) => {
        const ratio = index / 4;
        const exponent = growthViewport.yMaximum - growthViewport.ySpan * ratio;
        return {
          label: formatCount(10 ** exponent),
          y: GROWTH_GRAPH_PLOT_TOP + GROWTH_GRAPH_PLOT_HEIGHT * ratio,
        };
      }),
    [growthViewport],
  );
  useEffect(() => {
    setGrowthView((current) => {
      const next = normalizeGrowthView(growthGraphDomain, current);
      return next.zoom === current.zoom && next.centerX === current.centerX && next.centerY === current.centerY
        ? current
        : next;
    });
  }, [growthGraphDomain]);
  const allGrowthSeries = useMemo(
    () =>
      BENCHMARK_ALGORITHMS.map((benchmarkAlgorithm) => ({
        ...benchmarkAlgorithm,
        color: BENCHMARK_COLORS[benchmarkAlgorithm.key],
        points: theoreticalBenchmarkData.map((entry, index) => {
          const work = entry.work[benchmarkAlgorithm.key];
          return {
            size: entry.size,
            work,
            exponent: Math.log10(Math.max(work, 1)),
            normalizedX: index / Math.max(theoreticalBenchmarkData.length - 1, 1),
          };
        }),
      })),
    [theoreticalBenchmarkData],
  );
  const visibleGrowthSeries = useMemo(
    () =>
      allGrowthSeries
        .filter((benchmarkAlgorithm) => visibleGrowthAlgorithms[benchmarkAlgorithm.key])
        .map((benchmarkAlgorithm) => ({
          ...benchmarkAlgorithm,
          isFocused: growthFocusedAlgorithm === benchmarkAlgorithm.key,
          points: benchmarkAlgorithm.points.map((point) => ({
            ...point,
            x: GROWTH_GRAPH_PLOT_LEFT +
              ((point.normalizedX - growthViewport.xStart) / growthViewport.xSpan) * GROWTH_GRAPH_PLOT_WIDTH,
            y: GROWTH_GRAPH_PLOT_TOP +
              ((growthViewport.yMaximum - point.exponent) / growthViewport.ySpan) * GROWTH_GRAPH_PLOT_HEIGHT,
          })),
        })),
    [allGrowthSeries, growthFocusedAlgorithm, growthViewport, visibleGrowthAlgorithms],
  );
  const activeGrowthInspectionIndex = Math.min(
    Math.max(growthHoverIndex ?? growthInspectionIndex, 0),
    Math.max(theoreticalBenchmarkData.length - 1, 0),
  );
  const growthInspection = useMemo(() => {
    const entry = theoreticalBenchmarkData[activeGrowthInspectionIndex];
    const normalizedX = activeGrowthInspectionIndex / Math.max(theoreticalBenchmarkData.length - 1, 1);
    const x = GROWTH_GRAPH_PLOT_LEFT +
      ((normalizedX - growthViewport.xStart) / growthViewport.xSpan) * GROWTH_GRAPH_PLOT_WIDTH;
    const rows = allGrowthSeries
      .filter((series) => visibleGrowthAlgorithms[series.key])
      .map((series) => ({
        ...series,
        work: entry?.work[series.key] ?? 0,
      }))
      .sort((left, right) => right.work - left.work);
    const fastestWork = Math.max(1, rows.at(-1)?.work ?? 1);

    return {
      size: entry?.size ?? THEORY_BENCHMARK_SIZES[0],
      x,
      isVisible: x >= GROWTH_GRAPH_PLOT_LEFT && x <= GROWTH_GRAPH_PLOT_LEFT + GROWTH_GRAPH_PLOT_WIDTH,
      rows: rows.map((row) => ({ ...row, multiplier: row.work / fastestWork })),
    };
  }, [activeGrowthInspectionIndex, allGrowthSeries, growthViewport, theoreticalBenchmarkData, visibleGrowthAlgorithms]);

  const currentStep = useMemo(
    () =>
      isBogo && bogoLiveStep
        ? bogoLiveStep
        : steps[stepIndex] ?? createInitialStep(values, algorithm),
    [algorithm, bogoLiveStep, isBogo, stepIndex, steps, values],
  );
  const visibleValues = currentStep.values;
  const renderedBarItems = getRenderedBarItems(currentStep);
  const completionSweepDuration = getCompletionSweepDuration(renderedBarItems.length);
  const completionSweepStepDuration = completionSweepDuration / Math.max(renderedBarItems.length, 1);
  const previousVisualStep = !isBogo && stepIndex > 0 ? steps[stepIndex - 1] : null;
  const previousRenderedBarItems = previousVisualStep
    ? getRenderedBarItems(previousVisualStep)
    : [];
  const mergePassFrameCounts = useMemo(() => {
    if (algorithm !== "merge") return new Map<number, number>();

    return steps.reduce((counts, step) => {
      if (step.pass > 0 && step.phase !== "complete") {
        counts.set(step.pass, (counts.get(step.pass) ?? 0) + 1);
      }
      return counts;
    }, new Map<number, number>());
  }, [algorithm, steps]);
  const motionSlideDuration = Math.round(Math.max(170, 880 - interpolationSpeed * 9.4));
  const shouldInterpolateMoves =
    !isBogo && !prefersReducedMotion && interpolationSpeed < 75;
  const isSafeVisualMove =
    shouldInterpolateMoves &&
    previousVisualStep !== null &&
    haveSameBarTokens(previousRenderedBarItems, renderedBarItems) &&
    previousRenderedBarItems.some((item, index) => item.token !== renderedBarItems[index]?.token);

  useEffect(() => {
    if (!isBogo || runState !== "complete" || currentStep.phase !== "complete") {
      return;
    }

    if (soundEnabled) playBogoVictorySound();
    setBogoCelebrationPhase("visible");
    const celebrationFadeDuration = prefersReducedMotion ? 0 : BOGO_CELEBRATION_FADE_DURATION;
    const fadeTimer = window.setTimeout(
      () => setBogoCelebrationPhase("fading"),
      BOGO_CELEBRATION_VISIBLE_DURATION,
    );
    const unmountTimer = window.setTimeout(
      () => setBogoCelebrationPhase("hidden"),
      BOGO_CELEBRATION_VISIBLE_DURATION + celebrationFadeDuration,
    );

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(unmountTimer);
    };
  }, [currentStep.phase, isBogo, prefersReducedMotion, runState]);

  useEffect(() => {
    const hasFinishedSorting = runState === "complete" && currentStep.phase === "complete";

    if (!hasFinishedSorting) {
      resetCompletionSweep();
      return;
    }

    if (completionSweepStartedRef.current) return;
    completionSweepStartedRef.current = true;

    const beginSweep = () => {
      completionSweepStartTimerRef.current = null;
      startCompletionSweep(currentStep.values, completionSweepDuration);
    };

    if (isBogo) {
      completionSweepStartTimerRef.current = window.setTimeout(
        beginSweep,
        BOGO_COMPLETION_SWEEP_DELAY,
      );
      return;
    }

    beginSweep();
  }, [completionSweepDuration, currentStep.phase, currentStep.values, isBogo, prefersReducedMotion, runState]);

  useLayoutEffect(() => {
    const captureMotionBarPositions = () => {
      const positions = new Map<string, number>();

      renderedBarItems.forEach((item) => {
        const bar = motionBarElementsRef.current.get(item.token);
        if (bar) positions.set(item.token, bar.getBoundingClientRect().left);
      });

      return positions;
    };

    const nextTokens = renderedBarItems.map((item) => item.token);
    if (!shouldInterpolateMoves) {
      motionBarPositionsRef.current = captureMotionBarPositions();
      motionBarTokensRef.current = nextTokens;
      setMotionSlideOffsets((current) => (Object.keys(current).length === 0 ? current : {}));
      setMotionSlideStage((stage) => (stage === "idle" ? stage : "idle"));
      return;
    }

    const nextPositions = captureMotionBarPositions();
    const previousTokens = motionBarTokensRef.current;
    const hasSameTokens =
      previousTokens.length === nextTokens.length &&
      previousTokens.every((token) => nextTokens.includes(token));

    if (!isSafeVisualMove || !hasSameTokens) {
      motionBarPositionsRef.current = nextPositions;
      motionBarTokensRef.current = nextTokens;
      return;
    }

    const offsets: Record<string, number> = {};
    let hasMovement = false;

    nextPositions.forEach((nextLeft, token) => {
      const previousLeft = motionBarPositionsRef.current.get(token);
      if (previousLeft === undefined) return;

      const offset = previousLeft - nextLeft;
      if (Math.abs(offset) < 1) return;
      offsets[token] = offset;
      hasMovement = true;
    });

    motionBarPositionsRef.current = nextPositions;
    motionBarTokensRef.current = nextTokens;
    if (!hasMovement) return;

    setMotionSlideOffsets(offsets);
    setMotionSlideStage("prepare");

    let settleFrame: number | undefined;
    let releaseTimer: number | undefined;
    const startFrame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        setMotionSlideOffsets({});
        setMotionSlideStage("animate");
        releaseTimer = window.setTimeout(() => setMotionSlideStage("idle"), motionSlideDuration);
      });
    });

    return () => {
      window.cancelAnimationFrame(startFrame);
      if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame);
      if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
    };
  }, [currentStep, isSafeVisualMove, motionSlideDuration, shouldInterpolateMoves]);

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
  }, [practiceStepIndex, practiceValues, prefersReducedMotion]);

  const isRunning = runState === "running";
  const isLocked = isRunning || runState === "paused";
  const isLargeArray = originalValues.length > DEFAULT_ARRAY_SIZE;
  const playbackDensity = isBogo ? 48 : 1;
  // Use the internal 1–200 playback range for deterministic sorts, while the
  // visible control remains a simple 1–100% scale.
  const speedDelay =
    playbackSpeed <= 100
      ? Math.round(4 + 716 * (1 - (playbackSpeed - 1) / 99) ** 1.3)
      : Math.max(1, Math.round(4 * (1 - (playbackSpeed - 100) / (MAX_SPEED - 100)) ** 2));
  // Non-Bogo runs share the same animation floor through the deliberately
  // slow first half of the dial. This keeps a lower speed meaningfully slow
  // regardless of array size instead of making short rows race ahead.
  const standardMinimumFrameDelay = isBogo
    ? playbackSpeed > 100
      ? 2
      : playbackSpeed === 100
        ? 3
        : 7
    : 16;
  // At the fast end, a short row has far fewer snapshots to show, so its
  // minimum frame time rises smoothly as the row gets smaller. That keeps a
  // 4–24 value sort quick at 100% without letting it disappear in one blink;
  // 25+ values retain the existing fast, smooth large-row floor.
  const highSpeedProgress = Math.max(
    0,
    Math.min(1, (playbackSpeed - 100) / (MAX_SPEED - 100)),
  );
  const compactRowRatio = Math.max(
    0,
    Math.min(1, (DEFAULT_ARRAY_SIZE - originalValues.length) / (DEFAULT_ARRAY_SIZE - 4)),
  );
  const smallRowHighSpeedFloor = 8 + 32 * compactRowRatio ** 1.35;
  const highSpeedMinimumFrameDelay = isLargeArray ? 8 : smallRowHighSpeedFloor;
  const minimumFrameDelay = !isBogo && playbackSpeed > 100
    ? Math.round(
        16 + (highSpeedMinimumFrameDelay - 16) * highSpeedProgress,
      )
    : standardMinimumFrameDelay;
  const bogoSlowMotionDelay =
    isBogo && originalValues.length <= DEFAULT_ARRAY_SIZE
      ? getBogoSlowMotionDelay(speed)
      : 0;
  const usesEvenMergePacing =
    algorithm === "merge" &&
    currentStep.phase !== "ready" &&
    currentStep.phase !== "complete";
  const mergeSlowdown = 1 - (speed - 1) / (DISPLAY_SPEED_MAX - 1);
  const mergePassDuration = Math.round(600 + 6_000 * mergeSlowdown ** 1.5);
  const mergeFramesInCurrentPass = mergePassFrameCounts.get(currentStep.pass) ?? 1;
  const delay = prefersReducedMotion
    ? 18
    : usesEvenMergePacing
      ? Math.max(minimumFrameDelay, mergePassDuration / mergeFramesInCurrentPass)
      // Keep the settled visual mode stable while the slider is held, but do
      // not let that temporary mode pin the runner to a slow FLIP duration.
      // The value itself must still change speed on every live slider input.
      : isSafeVisualMove && !isAdjustingSpeedControl
        ? motionSlideDuration + 100
      : Math.max(minimumFrameDelay, speedDelay / playbackDensity);
  const shouldInterpolateDenseBars =
    isLargeArray && !isBogo && !prefersReducedMotion && interpolationSpeed <= 50;
  const denseBarTransitionStyle = shouldInterpolateDenseBars
    ? ({
        "--bar-transition-duration": String(Math.min(260, Math.max(90, delay * 0.75))) + "ms",
      } as CSSProperties)
    : undefined;
  const barTransitionStyle = shouldInterpolateMoves
      ? ({
          ...(denseBarTransitionStyle ?? {}),
          "--bar-slide-duration": String(motionSlideDuration) + "ms",
        } as CSSProperties)
      : denseBarTransitionStyle;
  const activeBarTransitionStyle = barTransitionStyle;
  const progress =
    runState === "complete"
      ? 100
      : isBogo
        ? bogoRunsUntilSolved
          ? 0
          : Math.round((currentStep.pass / Math.max(bogoAttemptLimit, 1)) * 100)
      : steps.length > 1
        ? Math.round((stepIndex / (steps.length - 1)) * 100)
        : 0;
  const displayValues = visibleValues.join(", ");
  const largestValue = Math.max(...originalValues, 1);
  const liveStatus =
    currentStep.phase === "limited"
      ? "Bogo Sort stopped after the shuffle safety limit. Try a new array or another algorithm."
      : runState === "complete"
        ? "Sorting complete. " + currentStep.comparisons + " comparisons and " + currentStep.writes + " array writes."
      : runState === "paused"
        ? "Paused during " +
          stageLabel +
          " " +
          currentStep.pass +
          (isBogo && bogoRunsUntilSolved ? " with no shuffle cap." : " of " + totalStages + ".")
        : runState === "running"
          ? algorithmLabel +
            " is working through " +
            stageLabel +
            " " +
            currentStep.pass +
            (isBogo && bogoRunsUntilSolved ? " with no shuffle cap." : " of " + totalStages + ".")
          : "Ready to demonstrate " + algorithmLabel + ".";

  function resetBogoElapsedTimer() {
    const stopwatch = bogoElapsedTimerRef.current;
    stopwatch.generation += 1;
    stopwatch.accumulatedMilliseconds = 0;
    stopwatch.startedAt = null;
    bogoExpectedRateSampleRef.current = null;
    setBogoFrozenExpectedShuffleRate(null);
    setBogoExpectedRateSource("calibrating");
    setBogoElapsedMilliseconds(0);
  }

  function getBogoActiveElapsedMilliseconds(now = performance.now()) {
    const stopwatch = bogoElapsedTimerRef.current;
    return (
      stopwatch.accumulatedMilliseconds +
      (stopwatch.startedAt === null ? 0 : Math.max(0, now - stopwatch.startedAt))
    );
  }

  function restartBogoExpectedRateCalibration(
    session: BogoSession | null,
    modeledShuffleRate: number,
  ) {
    // A Bogo speed change changes the runner's real throughput. Start a fresh
    // sample from this exact point so the estimate follows the new speed,
    // while the stopwatch and shuffle count continue uninterrupted.
    setBogoFrozenExpectedShuffleRate(null);
    setBogoExpectedRateSource("calibrating");
    setBogoMeasuredShuffleRate(null);

    if (!session || session.done) {
      bogoExpectedRateSampleRef.current = null;
      return;
    }

    const now = performance.now();
    bogoExpectedRateSampleRef.current = {
      startingAttempts: session.attempts,
      startingElapsedMilliseconds: getBogoActiveElapsedMilliseconds(now),
      modeledShuffleRate,
      finalized: false,
    };
  }

  function resetCompletionSweep() {
    if (completionSweepStartTimerRef.current !== null) {
      window.clearTimeout(completionSweepStartTimerRef.current);
      completionSweepStartTimerRef.current = null;
    }
    if (completionSweepEndTimerRef.current !== null) {
      window.clearTimeout(completionSweepEndTimerRef.current);
      completionSweepEndTimerRef.current = null;
    }
    completionSweepRunRef.current += 1;
    stopCompletionSweepSound();
    completionSweepStartedRef.current = false;
    setCompletionSweepActive(false);
  }

  function stopCompletionSweepSound() {
    completionSweepSourcesRef.current.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that already ended does not need any further cleanup.
      }
    });
    completionSweepSourcesRef.current.clear();
  }

  function startCompletionSweep(sweepValues: number[], duration: number) {
    stopCompletionSweepSound();
    const sweepRun = completionSweepRunRef.current + 1;
    completionSweepRunRef.current = sweepRun;
    setCompletionSweepActive(true);

    if (!prefersReducedMotion && soundVolumeRef.current > 0) {
      const context = ensureAudioContext();
      void context.resume().then(() => {
        if (completionSweepRunRef.current !== sweepRun) return;
        playCompletionSweepSound(sweepValues, duration);
      }).catch(() => undefined);
    }

    completionSweepEndTimerRef.current = window.setTimeout(() => {
      completionSweepEndTimerRef.current = null;
      if (completionSweepRunRef.current !== sweepRun) return;
      stopCompletionSweepSound();
      setCompletionSweepActive(false);
    }, duration + COMPLETION_SWEEP_AUDIO_VISUAL_LEAD + COMPLETION_SWEEP_RELEASE_TAIL);
  }

  function ensureAudioContext() {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }

    if (audioContextRef.current.state === "suspended") {
      void audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }

  function playMusicalVoice(
    context: AudioContext,
    startTime: number,
    frequency: number,
    targetDuration: number,
    peakGain: number,
    trackedSources?: Set<OscillatorNode>,
  ) {
    // Keep even the shortest voice long enough to read as a note, with an
    // octave reinforcement that stays clear on laptop speakers.
    const duration = Math.min(0.12, Math.max(targetDuration, 4.5 / Math.max(frequency, 1)));
    const attack = Math.min(0.006, Math.max(0.002, duration * 0.11));
    const bodyTime = Math.max(attack + 0.008, duration * 0.5);
    const fundamental = context.createOscillator();
    const octave = context.createOscillator();
    const fundamentalLevel = context.createGain();
    const octaveLevel = context.createGain();
    const rumbleFilter = context.createBiquadFilter();
    const toneFilter = context.createBiquadFilter();
    const envelope = context.createGain();

    fundamental.type = "triangle";
    fundamental.frequency.setValueAtTime(frequency, startTime);
    octave.type = "sine";
    octave.frequency.setValueAtTime(frequency * 2, startTime);
    fundamentalLevel.gain.setValueAtTime(0.82, startTime);
    octaveLevel.gain.setValueAtTime(0.46, startTime);
    // Remove sub-bass rumble, while the C3 harmonic makes the C2 root clear.
    rumbleFilter.type = "highpass";
    rumbleFilter.frequency.setValueAtTime(52, startTime);
    rumbleFilter.Q.setValueAtTime(0.45, startTime);
    toneFilter.type = "lowpass";
    toneFilter.frequency.setValueAtTime(2_200, startTime);
    toneFilter.Q.setValueAtTime(0.45, startTime);
    envelope.gain.setValueAtTime(0.0001, startTime);
    envelope.gain.exponentialRampToValueAtTime(peakGain, startTime + attack);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peakGain * 0.66),
      startTime + bodyTime,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    fundamental.connect(fundamentalLevel);
    octave.connect(octaveLevel);
    fundamentalLevel.connect(rumbleFilter);
    octaveLevel.connect(rumbleFilter);
    rumbleFilter.connect(toneFilter);
    toneFilter.connect(envelope);
    envelope.connect(context.destination);

    if (trackedSources) {
      trackedSources.add(fundamental);
      trackedSources.add(octave);
      fundamental.addEventListener("ended", () => trackedSources.delete(fundamental), { once: true });
      octave.addEventListener("ended", () => trackedSources.delete(octave), { once: true });
    }

    fundamental.start(startTime);
    octave.start(startTime);
    fundamental.stop(startTime + duration + 0.015);
    octave.stop(startTime + duration + 0.015);
  }

  function getSortingToneFrequency(value: number) {
    const pianoFrequency = smallArrayPianoToneMap?.get(value);
    if (pianoFrequency !== undefined) return pianoFrequency;

    return getContinuousToneFrequency(value, largestValue);
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
    const isImpact =
      step.phase === "swap" ||
      step.phase === "shift" ||
      step.phase === "insert" ||
      step.phase === "merge";
    const targetDuration = isImpact ? 0.052 : 0.034;
    const basePeakGain = isImpact ? 0.2 : 0.14;
    const peakGain = basePeakGain * (soundVolume / 100) ** 2.5;
    const frequency = getSortingToneFrequency(activeValue);

    playMusicalVoice(context, now, frequency, targetDuration, peakGain);
  }

  function playCompletionSweepSound(sweepValues: number[], duration: number) {
    const context = audioContextRef.current;
    const volume = soundVolumeRef.current;
    if (!context || context.state !== "running" || volume <= 0) return;

    const valuesToScan = sweepValues.length ? sweepValues : originalValues;
    if (valuesToScan.length === 0) return;

    const spacing = duration / 1_000 / valuesToScan.length;
    const startTime = context.currentTime + COMPLETION_SWEEP_AUDIO_VISUAL_LEAD / 1_000;
    const liveImpactPeak = 0.2 * (volume / 100) ** 2.5;

    // Each orange bar gets a matching note at the center of its scan window.
    // That keeps the verification sound count exactly aligned with the array.
    valuesToScan.forEach((value, index) => {
      const frequency = getSortingToneFrequency(value);
      const requestedDuration = Math.min(0.052, Math.max(0.012, spacing * 0.9));
      const actualVoiceDuration = Math.min(
        0.12,
        Math.max(requestedDuration, 4.5 / Math.max(frequency, 1)),
      );
      const overlap = Math.max(1, actualVoiceDuration / spacing);
      const peakGain = liveImpactPeak / Math.sqrt(overlap);

      playMusicalVoice(
        context,
        startTime + (index + 0.5) * spacing,
        frequency,
        requestedDuration,
        peakGain,
        completionSweepSourcesRef.current,
      );
    });
  }

  function playBogoShuffleTexture(attempt: number) {
    const context = audioContextRef.current;
    if (!context || context.state !== "running" || soundVolume <= 0) return;

    const now = context.currentTime;
    if (now - lastBogoTextureTimeRef.current < 0.13) return;
    lastBogoTextureTimeRef.current = now;

    const motion = ((attempt * 0.61803398875) % 1 + 1) % 1;
    // Bogo is throttled independently, but its audible hit uses the same
    // reinforced voice and impact level as a regular sorting move. The prior
    // one-oscillator bandpass texture was being attenuated enough to sound
    // markedly quieter than the rest of the visualizer.
    const frequency = 293.66 + motion * 340;
    const peakGain = 0.2 * (soundVolume / 100) ** 2.5;
    playMusicalVoice(context, now, frequency, 0.075, peakGain);
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
      // A victory note is a single oscillator, whereas sorting notes have an
      // octave reinforcement. Lift its envelope to the equivalent perceived
      // range so a successful Bogo run does not fall behind the live texture.
      const peakGain = 0.24 * (soundVolume / 100) ** 2.5;

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
      if (practiceUndoTimerRef.current !== null) {
        window.clearTimeout(practiceUndoTimerRef.current);
      }
      if (practiceAdvanceTimerRef.current !== null) {
        window.clearTimeout(practiceAdvanceTimerRef.current);
      }
      if (practiceClickSuppressionTimerRef.current !== null) {
        window.clearTimeout(practiceClickSuppressionTimerRef.current);
      }
      if (completionSweepStartTimerRef.current !== null) {
        window.clearTimeout(completionSweepStartTimerRef.current);
      }
      if (completionSweepEndTimerRef.current !== null) {
        window.clearTimeout(completionSweepEndTimerRef.current);
      }
      completionSweepRunRef.current += 1;
      stopCompletionSweepSound();
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

      const rateSample = bogoRateSampleRef.current;
      const now = performance.now();
      if (
        rateSample &&
        (session.done || now - rateSample.lastReportedAt >= BOGO_RATE_SAMPLE_INTERVAL)
      ) {
        const elapsed = now - rateSample.startedAt;
        const attempts = session.attempts - rateSample.startingAttempts;

        if (elapsed >= BOGO_RATE_SAMPLE_INTERVAL && attempts > 0) {
          rateSample.lastReportedAt = now;
          setBogoMeasuredShuffleRate((attempts * 1_000) / elapsed);
        }
      }

      const expectedRateSample = bogoExpectedRateSampleRef.current;
      if (expectedRateSample && !expectedRateSample.finalized) {
        const elapsedMilliseconds = Math.max(
          0,
          getBogoActiveElapsedMilliseconds(now) - expectedRateSample.startingElapsedMilliseconds,
        );
        const attempts = session.attempts - expectedRateSample.startingAttempts;
        const hasMeasuredOpeningRate =
          elapsedMilliseconds >= BOGO_EXPECTED_RATE_FREEZE_AFTER && attempts > 0;

        if (hasMeasuredOpeningRate || session.done) {
          expectedRateSample.finalized = true;
          setBogoFrozenExpectedShuffleRate(
            hasMeasuredOpeningRate
              ? (attempts * 1_000) / elapsedMilliseconds
              : expectedRateSample.modeledShuffleRate,
          );
          setBogoExpectedRateSource(hasMeasuredOpeningRate ? "measured" : "modeled");
        }
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
  }, [bogoModeledShuffleRate, bogoSlowMotionDelay, isBogo, runState]);

  useEffect(() => {
    if (!isBogo || runState !== "running") return;

    const stopwatch = bogoElapsedTimerRef.current;
    const generation = stopwatch.generation;
    stopwatch.startedAt = performance.now();

    const updateElapsedTime = () => {
      if (stopwatch.generation !== generation || stopwatch.startedAt === null) {
        return;
      }

      setBogoElapsedMilliseconds(
        stopwatch.accumulatedMilliseconds + Math.max(0, performance.now() - stopwatch.startedAt),
      );
    };

    updateElapsedTime();
    const timer = window.setInterval(updateElapsedTime, 100);

    return () => {
      window.clearInterval(timer);
      if (stopwatch.generation !== generation || stopwatch.startedAt === null) {
        return;
      }

      stopwatch.accumulatedMilliseconds += Math.max(0, performance.now() - stopwatch.startedAt);
      stopwatch.startedAt = null;
      setBogoElapsedMilliseconds(stopwatch.accumulatedMilliseconds);
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
    resetCompletionSweep();
    resetBogoElapsedTimer();
    const nextValues = makeRandomArray(size);
    setBogoCelebrationPhase("hidden");
    bogoSessionRef.current = null;
    bogoRateSampleRef.current = null;
    setBogoLiveStep(null);
    setBogoMeasuredShuffleRate(null);
    setOriginalValues(nextValues);
    setValues(nextValues);
    setSteps([]);
    setStepIndex(0);
    setRunState("ready");
  }

  function resetArray() {
    resetCompletionSweep();
    resetBogoElapsedTimer();
    setBogoCelebrationPhase("hidden");
    bogoSessionRef.current = null;
    bogoRateSampleRef.current = null;
    setBogoLiveStep(null);
    setBogoMeasuredShuffleRate(null);
    setValues([...originalValues]);
    setSteps([]);
    setStepIndex(0);
    setRunState("ready");
  }

  function handleSoundVolumeChange(nextVolume: number) {
    if (nextVolume > 0 && soundVolume === 0) ensureAudioContext();
    setSoundVolume(nextVolume);
  }

  function setMotionBarRef(token: string, element: HTMLDivElement | null) {
    if (element) {
      motionBarElementsRef.current.set(token, element);
      return;
    }
    motionBarElementsRef.current.delete(token);
  }

  function clearPracticeUndo() {
    if (practiceUndoTimerRef.current !== null) {
      window.clearTimeout(practiceUndoTimerRef.current);
      practiceUndoTimerRef.current = null;
    }
    setPracticeUndoPending(false);
  }

  function clearPracticeAdvance() {
    if (practiceAdvanceTimerRef.current !== null) {
      window.clearTimeout(practiceAdvanceTimerRef.current);
      practiceAdvanceTimerRef.current = null;
    }
  }

  function clearPracticeClickSuppression() {
    if (practiceClickSuppressionTimerRef.current !== null) {
      window.clearTimeout(practiceClickSuppressionTimerRef.current);
      practiceClickSuppressionTimerRef.current = null;
    }
    suppressPracticeClickRef.current = false;
  }

  function suppressPracticeClickAfterDrag() {
    clearPracticeClickSuppression();
    suppressPracticeClickRef.current = true;
    // A browser normally emits the click that follows pointer-up before this
    // timer. If it does not, clear the guard before the person's next click.
    practiceClickSuppressionTimerRef.current = window.setTimeout(() => {
      practiceClickSuppressionTimerRef.current = null;
      suppressPracticeClickRef.current = false;
    }, 0);
  }

  function schedulePracticeAdvance() {
    clearPracticeAdvance();
    // Leave just enough time for the blocks to finish their smooth swap, then
    // flow directly into the next rule without asking for a separate click.
    practiceAdvanceTimerRef.current = window.setTimeout(() => {
      practiceAdvanceTimerRef.current = null;
      advancePracticeStep();
    }, 520);
  }

  function completePracticeWalkthrough() {
    clearPracticeUndo();
    clearPracticeAdvance();
    setPracticeStepIndex(practiceSteps.length);
    setPracticeSelectedIndex(null);
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropIndex(null);
    setPracticeDropMode(null);
    practicePointerRef.current = null;
    practiceDropTargetRef.current = null;
    setPracticeSolved(true);
    setPracticeFeedback("Fully sorted—this completes the walkthrough.");
  }

  function resetPractice(nextAlgorithm = algorithm) {
    clearPracticeUndo();
    clearPracticeAdvance();
    clearPracticeClickSuppression();
    const firstStep = normalizePracticeSteps(ALGORITHM_DETAILS[nextAlgorithm].practice)[0];
    setPracticeStepIndex(0);
    setPracticeSelectedIndex(null);
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropIndex(null);
    setPracticeDropMode(null);
    practicePointerRef.current = null;
    practiceDropTargetRef.current = null;
    setPracticeSolved(false);
    setPracticeFeedback(null);
    setPracticeValues([...firstStep.start]);
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

  function getPracticeDropRegion(
    element: HTMLElement,
    index: number,
    hitSlop = 0,
  ): PracticeDropRegion {
    const rect = element.getBoundingClientRect();
    return {
      index,
      left: rect.left - hitSlop,
      right: rect.right + hitSlop,
      top: rect.top - hitSlop,
      bottom: rect.bottom + hitSlop,
    };
  }

  function setPracticeDropTarget(target: PracticeDropTarget | null) {
    practiceDropTargetRef.current = target;
    setPracticeDropIndex((current) => (current === target?.index ? current : target?.index ?? null));
    setPracticeDropMode((current) => (current === target?.mode ? current : target?.mode ?? null));
  }

  function evaluatePracticeMove(nextValues: number[]): PracticeMoveResult {
    // A lesson can sometimes reach the finished row by a legitimate shortcut
    // before its scripted final sub-step (Heap Sort is a clear example). The
    // global completion check comes first so a truly sorted permutation never
    // becomes stranded waiting for a no-longer-needed scripted move. It also
    // remains safe for Quick Sort: only the actual fully sorted row can take
    // this path, not a merely plausible-looking pivot placement.
    if (isPracticeRowFinished(nextValues, currentPractice.target)) {
      return "complete";
    }

    if (arraysMatch(nextValues, currentPractice.target)) {
      setPracticeSolved(true);
      setPracticeFeedback(
        practiceStepIndex === practiceSteps.length - 1
          ? "Correct—this completes the walkthrough."
          : "Correct. Your move follows the rule; the next step is loading.",
      );
      return "solved";
    }

    // Quick Sort's lesson is deliberately one safe partition move at a time.
    // Letting a merely "closer" swap remain can strand the pivot between
    // values with no legal next move, which is both confusing and unlike the
    // intended partition sequence.
    if (isQuickPractice) {
      setPracticeSolved(false);
      setPracticeFeedback("That does not complete this pivot's move, so it will slide back. Hint: " + currentPractice.hint);
      return "wrong";
    }

    // Prefer moves that put more pairs in their final relative order. A
    // position-distance tie-break keeps the lesson moving forward without
    // rejecting a legitimate swap whose two values trade equally distant slots.
    const madeProgress = isPracticeMoveProgress(
      practiceValues,
      nextValues,
      currentPractice.target,
    );
    setPracticeSolved(false);
    setPracticeFeedback(
      madeProgress
        ? "Good move—this arrangement is closer to this step's target. Keep going."
        : "Not quite. Hint: " + currentPractice.hint,
    );
    return madeProgress ? "progress" : "wrong";
  }

  function schedulePracticeUndo(previousValues: number[]) {
    setPracticeUndoPending(true);
    practiceUndoTimerRef.current = window.setTimeout(() => {
      setPracticeValues(previousValues);
      setPracticeFeedback("That move breaks this step's rule, so it slid back. Hint: " + currentPractice.hint);
      practiceUndoTimerRef.current = null;
      setPracticeUndoPending(false);
    }, 440);
  }

  function movePracticeItem(
    fromIndex: number,
    toIndex: number,
    capturePosition = true,
    mode: "swap" | "insert" = "swap",
  ) {
    if (practiceFinished || practiceUndoPending) return;
    if (capturePosition) {
      practiceBlockPositionsRef.current = capturePracticeBlockPositions();
    }

    const previousValues = [...practiceValues];
    const nextValues = applyPracticeMove(practiceValues, fromIndex, toIndex, mode);
    if (arraysMatch(nextValues, previousValues)) return;
    setPracticeValues(nextValues);
    const result = evaluatePracticeMove(nextValues);
    if (result === "wrong") {
      schedulePracticeUndo(previousValues);
    } else if (result === "complete") {
      completePracticeWalkthrough();
    } else if (result === "solved") {
      schedulePracticeAdvance();
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

  function getPracticeDropTarget(clientX: number, clientY: number): PracticeDropTarget | null {
    const board = practiceBoardRef.current;
    if (!board) return null;

    const boardRect = board.getBoundingClientRect();
    if (
      clientX < boardRect.left ||
      clientX > boardRect.right ||
      clientY < boardRect.top ||
      clientY > boardRect.bottom
    ) {
      return null;
    }

    const sourceIndex = practicePointerRef.current?.fromIndex ?? -1;
    const blocks = Array.from(board.querySelectorAll<HTMLElement>("[data-practice-index]"))
      .map((block) => {
        const index = Number(block.dataset.practiceIndex);
        return Number.isInteger(index)
          ? getPracticeDropRegion(block, index, PRACTICE_DIRECT_DROP_HIT_SLOP)
          : null;
      })
      .filter((region): region is PracticeDropRegion => region !== null);
    const gaps = Array.from(board.querySelectorAll<HTMLElement>("[data-practice-drop-index]"))
      .map((gap) => {
        const index = Number(gap.dataset.practiceDropIndex);
        return Number.isInteger(index) ? getPracticeDropRegion(gap, index) : null;
      })
      .filter((region): region is PracticeDropRegion => region !== null);

    return resolvePracticeDropTarget(
      clientX,
      clientY,
      sourceIndex,
      blocks,
      gaps,
      practicePointerRef.current?.sourceOrigin,
    );
  }

  function finishPracticeDrag(
    event?: ReactPointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) {
    const drag = practicePointerRef.current;
    if (!drag) return;
    if (event && event.pointerId !== drag.pointerId) return;

    // Resolve against the live geometry on release. The highlighted target is
    // intentionally never trusted as the action source: it can be one render
    // behind a quick pointer-up, or stale after a cancelled drag.
    const target = cancelled
      ? null
      : event
        ? getPracticeDropTarget(event.clientX, event.clientY)
        : practiceDropTargetRef.current;
    const destination = target?.index ?? null;
    const moveMode = target?.mode ?? "insert";
    const nextValues =
      destination === null
        ? practiceValues
        : applyPracticeMove(practiceValues, drag.fromIndex, destination, moveMode);
    const shouldMove =
      !cancelled &&
      drag.moved &&
      destination !== null &&
      !arraysMatch(nextValues, practiceValues);
    if (drag.moved) {
      // Never turn the pointer-up's synthetic click into a new selection—this
      // applies to successful, no-op, outside-board, and cancelled drags.
      suppressPracticeClickAfterDrag();
    }
    if (shouldMove) {
      practiceBlockPositionsRef.current = capturePracticeBlockPositions();
      movePracticeItem(
        drag.fromIndex,
        destination,
        false,
        moveMode,
      );
    }

    practicePointerRef.current = null;
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropTarget(null);
  }

  function handlePracticePointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    index: number,
    id: string,
  ) {
    if (practiceFinished || practiceUndoPending || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    practicePointerRef.current = {
      id,
      fromIndex: index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // Added to the pointer delta below, this shifts the block's center
      // directly underneath the pointer rather than preserving the initial
      // point where it was picked up.
      anchorX: event.clientX - (bounds.left + bounds.width / 2),
      anchorY: event.clientY - (bounds.top + bounds.height / 2),
      sourceOrigin: {
        index,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      },
      moved: false,
    };
    // Do not alter the board layout until this becomes a real drag. A normal
    // click still selects one block, and the first drag frame can measure the
    // same stable geometry the pointer started from.
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropTarget(null);
  }

  function handlePracticePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = practicePointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 5 && !drag.moved) {
      drag.moved = true;
      setPracticeDragIndex(drag.fromIndex);
      setPracticeDraggingId(drag.id);
    }
    if (!drag.moved) return;

    event.preventDefault();
    setPracticeDragOffset({ x: deltaX + drag.anchorX, y: deltaY + drag.anchorY });
    const target = getPracticeDropTarget(event.clientX, event.clientY);
    setPracticeDropTarget(target);
  }

  function advancePracticeStep() {
    clearPracticeUndo();
    clearPracticeAdvance();
    const nextStepIndex = practiceStepIndex + 1;
    if (nextStepIndex >= practiceSteps.length) {
      setPracticeStepIndex(practiceSteps.length);
      setPracticeSelectedIndex(null);
      setPracticeDragIndex(null);
      setPracticeDraggingId(null);
      setPracticeDragOffset({ x: 0, y: 0 });
      setPracticeDropIndex(null);
      setPracticeDropMode(null);
      practicePointerRef.current = null;
      practiceDropTargetRef.current = null;
      setPracticeSolved(false);
      return;
    }

    const nextStep = practiceSteps[nextStepIndex];
    setPracticeStepIndex(nextStepIndex);
    setPracticeSelectedIndex(null);
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropIndex(null);
    setPracticeDropMode(null);
    practicePointerRef.current = null;
    practiceDropTargetRef.current = null;
    setPracticeSolved(false);
    setPracticeFeedback(null);
    setPracticeValues([...nextStep.start]);
  }

  function handleAlgorithmChange(nextAlgorithm: AlgorithmId) {
    resetCompletionSweep();
    resetBogoElapsedTimer();
    setBogoCelebrationPhase("hidden");
    bogoSessionRef.current = null;
    bogoRateSampleRef.current = null;
    setBogoLiveStep(null);
    setBogoMeasuredShuffleRate(null);
    const nextMaximumArraySize =
      nextAlgorithm === "bogo" ? BOGO_MAX_ARRAY_SIZE : 256;
    const nextArraySize = Math.min(arraySize, nextMaximumArraySize);
    const nextValues =
      nextArraySize === arraySize ? [...originalValues] : makeRandomArray(nextArraySize);
    setAlgorithm(nextAlgorithm);
    if (nextArraySize !== arraySize) {
      setArraySize(nextArraySize);
      setArraySizeInput(String(nextArraySize));
    }
    setOriginalValues(nextValues);
    setValues(nextValues);
    setSteps([]);
    setStepIndex(0);
    setRunState("ready");
    resetPractice(nextAlgorithm);
  }

  function handlePrimaryAction(startWithNewArray = false) {
    if (!startWithNewArray && runState === "running") {
      setRunState("paused");
      return;
    }

    if (!startWithNewArray && runState === "paused") {
      if (isBogo && bogoSessionRef.current) {
        bogoRateSampleRef.current = {
          startedAt: performance.now(),
          startingAttempts: bogoSessionRef.current.attempts,
          lastReportedAt: 0,
        };
        setBogoMeasuredShuffleRate(null);
      }
      setRunState("running");
      return;
    }

    // Finishing a run turns the primary action into a quick way to see the
    // selected algorithm on a genuinely new permutation, rather than replaying
    // the exact same input. While the board is merely ready, preserve its
    // current values so the initial and freshly resized examples can be sorted.
    const sortValues = startWithNewArray || runState === "complete"
      ? makeRandomArray(arraySize)
      : originalValues;
    if (startWithNewArray || runState === "complete") {
      setOriginalValues(sortValues);
    }

    const audioContext = soundEnabled ? ensureAudioContext() : null;
    resetCompletionSweep();
    resetBogoElapsedTimer();
    setBogoCelebrationPhase("hidden");
    if (algorithm === "bogo") {
      if (audioContext) {
        // Start one texture in the click gesture. Fast Bogo batches can finish
        // before the normal interval has time to produce an audible note.
        void audioContext.resume().then(() => playBogoShuffleTexture(0)).catch(() => undefined);
      }
      const session = createBogoSession(
        sortValues,
        bogoRunsUntilSolved ? null : bogoAttemptLimit,
      );
      bogoSessionRef.current = session;
      bogoRateSampleRef.current = {
        startedAt: performance.now(),
        startingAttempts: session.attempts,
        lastReportedAt: 0,
      };
      bogoExpectedRateSampleRef.current = {
        startingAttempts: session.attempts,
        startingElapsedMilliseconds: 0,
        modeledShuffleRate: bogoModeledShuffleRate,
        finalized: false,
      };
      if (session.done) {
        bogoExpectedRateSampleRef.current.finalized = true;
        setBogoFrozenExpectedShuffleRate(bogoModeledShuffleRate);
        setBogoExpectedRateSource("modeled");
      }
      setBogoMeasuredShuffleRate(null);
      setValues([...sortValues]);
      setSteps([]);
      setStepIndex(0);
      setBogoLiveStep(session.done ? getBogoSessionStep(session) : null);
      setRunState(session.done ? "complete" : "running");
      return;
    }

    bogoSessionRef.current = null;
    bogoRateSampleRef.current = null;
    setBogoLiveStep(null);
    setBogoMeasuredShuffleRate(null);
    const sequence =
      algorithm === "bubble"
        ? buildBubbleSteps(sortValues)
        : algorithm === "cocktail"
          ? buildCocktailSteps(sortValues)
          : algorithm === "selection"
            ? buildSelectionSteps(sortValues)
            : algorithm === "heap"
              ? buildHeapSortSteps(sortValues)
              : algorithm === "quick"
                ? buildQuickSortSteps(sortValues)
                : algorithm === "pdq"
                  ? buildPdqSortSteps(sortValues)
                : algorithm === "merge"
                  ? buildMergeSortSteps(sortValues)
                  : algorithm === "powersort"
                    ? buildPowerSortSteps(sortValues)
                  : buildInsertionSteps(sortValues);
    setValues([...sortValues]);
    setSteps(sequence);
    setStepIndex(0);
    setRunState(sequence.length > 1 ? "running" : "complete");
  }

  function handleArraySizeChange(nextSize: number) {
    const clampedSize = Math.min(maximumArraySize, Math.max(minimumArraySize, Math.round(nextSize)));
    setArraySize(clampedSize);
    setArraySizeInput(String(clampedSize));
    createNewArray(clampedSize);
  }

  function handleArraySizeInputChange(input: string) {
    setArraySizeInput(input);

    // Number steppers report a complete integer immediately. Commit that
    // value right away so their arrows (and a valid pasted value) redraw the
    // board just like the range slider. Keep partial or out-of-range typing
    // in place until blur so someone can still finish editing a larger value.
    const candidate = Number(input);
    if (
      input.trim() !== "" &&
      Number.isFinite(candidate) &&
      Number.isInteger(candidate) &&
      candidate >= minimumArraySize &&
      candidate <= maximumArraySize
    ) {
      handleArraySizeChange(candidate);
    }
  }

  function normalizeArraySizeInput() {
    const trimmedInput = arraySizeInput.trim();
    const numericValue = Number(trimmedInput);
    if (trimmedInput === "" || !Number.isFinite(numericValue)) {
      setArraySizeInput(String(arraySize));
      return;
    }
    const candidate = Math.round(numericValue);
    const clampedSize = Math.min(maximumArraySize, Math.max(minimumArraySize, candidate));
    if (clampedSize !== arraySize) {
      handleArraySizeChange(clampedSize);
      return;
    }
    setArraySizeInput(String(clampedSize));
  }

  function beginSpeedVisualAdjustment() {
    // Bogo does not use the move interpolation path, so there is nothing to
    // freeze there. For every other algorithm, retain the current visual mode
    // until the person finishes changing the control.
    if (isBogo) return;
    setSettledVisualSpeed(speedRef.current);
    setIsAdjustingSpeedControl(true);
  }

  function finishSpeedVisualAdjustment() {
    if (isBogo) return;
    // `speedRef` is updated synchronously by handleSpeedChange, which also
    // covers a final native range input that arrives just before pointer-up.
    setSettledVisualSpeed(speedRef.current);
    setIsAdjustingSpeedControl(false);
  }

  function isSpeedAdjustmentKey(key: string) {
    return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(key);
  }

  function handleSpeedChange(nextSpeed: number) {
    const clampedSpeed = Math.min(maximumSpeed, Math.max(1, Math.round(nextSpeed)));
    if (isBogo && clampedSpeed !== speed) {
      const session = bogoSessionRef.current;
      bogoRateSampleRef.current =
        session && runState === "running"
          ? {
              startedAt: performance.now(),
              startingAttempts: session.attempts,
              lastReportedAt: 0,
            }
          : null;
      restartBogoExpectedRateCalibration(session, getBogoEstimatedShuffleRate(clampedSpeed));
    }
    speedRef.current = clampedSpeed;
    setSpeed(clampedSpeed);
    setSpeedInput(String(clampedSpeed));
  }

  function handleSpeedInputChange(input: string) {
    // Native number steppers emit their change immediately, without waiting
    // for the field to blur. Apply every valid value here so their arrows
    // control a running animation just as directly as the range slider.
    const candidate = Number(input);
    if (input.trim() !== "" && Number.isFinite(candidate)) {
      handleSpeedChange(candidate);
      return;
    }

    // Keep incomplete text (such as a temporarily empty field) editable;
    // normalizeSpeedInput will restore or clamp it when editing finishes.
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

  function handleBogoRunsUntilSolvedChange(checked: boolean) {
    if (!checked) {
      setBogoRunsUntilSolved(false);
      return;
    }

    const confirmed = window.confirm(
      "Let Bogo Sort run until it solves?\n\nThis removes the shuffle cap. It may run until the sun explodes (or until you pause or reset it).",
    );
    setBogoRunsUntilSolved(confirmed);
  }

  function handleGrowthAlgorithmVisibilityToggle(nextAlgorithm: BenchmarkAlgorithm) {
    if (visibleGrowthAlgorithms[nextAlgorithm] && growthFocusedAlgorithm === nextAlgorithm) {
      setGrowthFocusedAlgorithm("all");
    }
    setVisibleGrowthAlgorithms((current) => ({
      ...current,
      [nextAlgorithm]: !current[nextAlgorithm],
    }));
  }

  function handleGrowthFocusChange(nextFocus: BenchmarkAlgorithm | "all") {
    setGrowthFocusedAlgorithm(nextFocus);
    if (nextFocus !== "all") {
      setVisibleGrowthAlgorithms((current) => ({ ...current, [nextFocus]: true }));
    }
  }

  function resetGrowthView() {
    setGrowthView({
      zoom: 1,
      centerX: 0.5,
      centerY: (growthGraphDomain.minimumExponent + growthGraphDomain.maximumExponent) / 2,
    });
  }

  function getGrowthPointerPosition(clientX: number, clientY: number, chart: HTMLDivElement) {
    const bounds = chart.getBoundingClientRect();
    const scaleX = GROWTH_GRAPH_WIDTH / Math.max(bounds.width, 1);
    const scaleY = GROWTH_GRAPH_HEIGHT / Math.max(bounds.height, 1);
    const chartX = (clientX - bounds.left) * scaleX;
    const chartY = (clientY - bounds.top) * scaleY;
    const plotX = clamp(chartX, GROWTH_GRAPH_PLOT_LEFT, GROWTH_GRAPH_PLOT_LEFT + GROWTH_GRAPH_PLOT_WIDTH);
    const plotY = clamp(chartY, GROWTH_GRAPH_PLOT_TOP, GROWTH_GRAPH_PLOT_TOP + GROWTH_GRAPH_PLOT_HEIGHT);
    const xRatio = (plotX - GROWTH_GRAPH_PLOT_LEFT) / GROWTH_GRAPH_PLOT_WIDTH;
    const yRatio = (plotY - GROWTH_GRAPH_PLOT_TOP) / GROWTH_GRAPH_PLOT_HEIGHT;
    const normalizedX = growthViewport.xStart + xRatio * growthViewport.xSpan;
    const exponent = growthViewport.yMaximum - yRatio * growthViewport.ySpan;
    const nearestIndex = Math.round(normalizedX * Math.max(theoreticalBenchmarkData.length - 1, 0));

    return {
      chartX,
      chartY,
      normalizedX,
      exponent,
      nearestIndex: clamp(nearestIndex, 0, Math.max(theoreticalBenchmarkData.length - 1, 0)),
    };
  }

  function handleGrowthChartPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const pointer = getGrowthPointerPosition(event.clientX, event.clientY, event.currentTarget);
    growthPanRef.current = {
      pointerId: event.pointerId,
      startX: pointer.chartX,
      startY: pointer.chartY,
      view: growthView,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleGrowthChartPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const pointer = getGrowthPointerPosition(event.clientX, event.clientY, event.currentTarget);
    const activePan = growthPanRef.current;
    if (!activePan || activePan.pointerId !== event.pointerId) {
      setGrowthHoverIndex(pointer.nearestIndex);
      return;
    }

    const deltaX = pointer.chartX - activePan.startX;
    const deltaY = pointer.chartY - activePan.startY;
    if (!activePan.moved && Math.hypot(deltaX, deltaY) > 4) {
      activePan.moved = true;
      setIsGrowthPanning(true);
    }
    if (activePan.moved) {
      setGrowthHoverIndex(null);
      setGrowthView(panGrowthView(growthGraphDomain, activePan.view, deltaX, deltaY));
    }
  }

  function finishGrowthChartPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const activePan = growthPanRef.current;
    if (!activePan || activePan.pointerId !== event.pointerId) return;
    const pointer = getGrowthPointerPosition(event.clientX, event.clientY, event.currentTarget);
    if (!activePan.moved) setGrowthInspectionIndex(pointer.nearestIndex);
    growthPanRef.current = null;
    setIsGrowthPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function cancelGrowthChartPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (growthPanRef.current?.pointerId !== event.pointerId) return;
    growthPanRef.current = null;
    setIsGrowthPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleGrowthChartWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const pointer = getGrowthPointerPosition(event.clientX, event.clientY, event.currentTarget);
    const multiplier = event.deltaY < 0 ? GROWTH_GRAPH_ZOOM_STEP : 1 / GROWTH_GRAPH_ZOOM_STEP;
    setGrowthHoverIndex(pointer.nearestIndex);
    setGrowthInspectionIndex(pointer.nearestIndex);
    setGrowthView((current) =>
      zoomGrowthView(growthGraphDomain, current, multiplier, pointer.normalizedX, pointer.exponent),
    );
  }

  function handleGrowthChartKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const panStep = 0.2;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setGrowthView((current) => zoomGrowthView(growthGraphDomain, current, GROWTH_GRAPH_ZOOM_STEP));
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      setGrowthView((current) => zoomGrowthView(growthGraphDomain, current, 1 / GROWTH_GRAPH_ZOOM_STEP));
      return;
    }
    if (event.key === "0" || event.key === "Home") {
      event.preventDefault();
      resetGrowthView();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setGrowthView((current) => panGrowthView(growthGraphDomain, current, GROWTH_GRAPH_PLOT_WIDTH * panStep, 0));
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setGrowthView((current) => panGrowthView(growthGraphDomain, current, -GROWTH_GRAPH_PLOT_WIDTH * panStep, 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setGrowthView((current) => panGrowthView(growthGraphDomain, current, 0, GROWTH_GRAPH_PLOT_HEIGHT * panStep));
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setGrowthView((current) => panGrowthView(growthGraphDomain, current, 0, -GROWTH_GRAPH_PLOT_HEIGHT * panStep));
    }
  }

  const primaryLabel =
    runState === "running"
      ? "Pause"
      : runState === "paused"
        ? "Resume"
        : runState === "complete"
          ? "Sort new array"
          : "Start sorting";

  return (
    <main className="sortlab-app">
      <div className="page-glow page-glow--one" aria-hidden="true" />
      <div className="page-glow page-glow--two" aria-hidden="true" />
      {bogoCelebrationPhase !== "hidden" && (
        <div
          className={
            "bogo-celebration " +
            (bogoCelebrationPhase === "fading" ? "bogo-celebration--fading " : "") +
            (prefersReducedMotion ? "bogo-celebration--reduced" : "")
          }
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
          <div className={"control-deck " + (isBogo ? "control-deck--bogo" : "")}>
            <div className="control-deck__intro">
              <p className="eyebrow">CONTROL ROOM</p>
              <h2 id="visualizer-title">{algorithmDetails.controlTitle}</h2>
            </div>

            {isBogo && (
              <aside
                className={
                  "bogo-run-timer bogo-run-timer--" + bogoTimerTone +
                  (runState === "paused" ? " bogo-run-timer--paused" : "")
                }
                aria-label={
                  "Bogo Sort run timer: " + formatBogoElapsedTime(bogoElapsedMilliseconds) + ". " + bogoTimerStatus + "."
                }
              >
                <span>RUN TIMER</span>
                <strong>{formatBogoElapsedTime(bogoElapsedMilliseconds)}</strong>
                <small>{bogoTimerStatus}</small>
              </aside>
            )}

            <div className={"controls " + (isBogo ? "controls--bogo" : "")} aria-label="Visualizer controls">
              <div className="algorithm-controls">
                <label className="control-field control-field--algorithm">
                  <span className="control-label">Algorithm</span>
                  <select
                    value={algorithm}
                    onChange={(event) => handleAlgorithmChange(event.target.value as AlgorithmId)}
                    disabled={isRunning}
                    aria-label="Sorting algorithm"
                  >
                    <option value="bogo">Bogo sort</option>
                    <option value="selection">Selection sort</option>
                    <option value="insertion">Insertion sort</option>
                    <option value="bubble">Bubble sort</option>
                    <option value="cocktail">Cocktail sort</option>
                    <option value="heap">Heap sort</option>
                    <option value="quick">Quick sort</option>
                    <option value="pdq">PDQ sort</option>
                    <option value="merge">Merge sort</option>
                    <option value="powersort">Powersort</option>
                  </select>
                </label>

                {isBogo && (
                  <>
                    <label className="control-field control-field--range bogo-attempt-limit">
                      <span className="control-label">
                      Max shuffles (up to 999,999,999)
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
                          disabled={isLocked || bogoRunsUntilSolved}
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
                        disabled={isLocked || bogoRunsUntilSolved}
                        aria-label="Maximum Bogo Sort shuffles"
                      />
                    </label>
                    <label
                      className={
                        "bogo-unlimited-warning " +
                        (bogoRunsUntilSolved ? "bogo-unlimited-warning--armed " : "") +
                        (isLocked ? "bogo-unlimited-warning--disabled" : "")
                      }
                    >
                      <input
                        type="checkbox"
                        checked={bogoRunsUntilSolved}
                        onChange={(event) => handleBogoRunsUntilSolvedChange(event.target.checked)}
                        disabled={isLocked}
                        aria-describedby="bogo-unlimited-warning-note"
                      />
                      <span>
                        <strong>Let it run until solved</strong>
                        <small id="bogo-unlimited-warning-note">
                          Warning: no cap — may run until the sun explodes.
                        </small>
                      </span>
                    </label>
                    <aside className="bogo-runtime-estimate" aria-live="polite">
                      <span>EXPECTED AVERAGE</span>
                      <strong>{bogoExpectedTime}</strong>
                      <small>
                        One sorted order in {formatBogoShuffleEstimate(bogoExpectedShuffles)} shuffles on average. {" "}
                        {bogoExpectedRateSource === "measured"
                          ? "Locked from the first 2.5 seconds at " + formatBogoShuffleRate(bogoExpectedShuffleRate) + "."
                          : bogoExpectedRateSource === "modeled"
                            ? "This run ended before calibration, so this estimate is locked to the start-up model at " + formatBogoShuffleRate(bogoExpectedShuffleRate) + "."
                            : runState === "paused"
                              ? "Calibration is paused with the run and locks after 2.5 seconds of active time."
                              : runState === "running"
                                ? "Calibrating the first 2.5 seconds at a provisional " + formatBogoShuffleRate(bogoExpectedShuffleRate) + "."
                                : "At " + speed + "% speed, the runner is modeled at " + formatBogoShuffleRate(bogoExpectedShuffleRate) + ". It locks after the first 2.5 seconds of a run."}{" "}
                        Individual runs can be much luckier or unluckier.
                      </small>
                      {runState === "complete" && currentStep.phase === "complete" && currentStep.pass > 0 && (
                        <small className="bogo-runtime-estimate__result">
                          This run found it after {currentStep.pass.toLocaleString("en-US")} shuffle
                          {currentStep.pass === 1 ? "" : "s"}.
                        </small>
                      )}
                    </aside>
                  </>
                )}
              </div>

              <label
                className={
                  "control-field control-field--range control-field--array-size " +
                  (isBogo ? "control-field--array-size-bogo" : "")
                }
              >
                <span className="control-label">
                  <span className="control-label__name">
                    Array size
                    {isBogo && <small>Max 24</small>}
                  </span>
                  <input
                    className={"control-number " + (isBogo ? "control-number--bogo-array" : "")}
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
                  aria-label="Array size"
                />
              </label>

              <label className="control-field control-field--range">
                <span className="control-label">
                  <span className="control-label__name">
                    Speed
                  </span>
                  {prefersReducedMotion ? (
                    <strong>instant</strong>
                  ) : (
                    <input
                      className="control-number"
                      type="number"
                      min="1"
                      max={maximumSpeed}
                      step="1"
                      value={speedInput}
                      onChange={(event) => handleSpeedInputChange(event.target.value)}
                      onFocus={beginSpeedVisualAdjustment}
                      onBlur={() => {
                        normalizeSpeedInput();
                        finishSpeedVisualAdjustment();
                      }}
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
                  max={maximumSpeed}
                  value={speed}
                  onChange={(event) => handleSpeedChange(Number(event.target.value))}
                  onPointerDown={(event) => {
                    // Pointer Events cover mouse, touch, and pen. Capturing
                    // the pointer guarantees release is observed even if the
                    // thumb is dragged outside the narrow range control.
                    event.currentTarget.setPointerCapture(event.pointerId);
                    beginSpeedVisualAdjustment();
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    finishSpeedVisualAdjustment();
                  }}
                  onPointerCancel={finishSpeedVisualAdjustment}
                  onBlur={finishSpeedVisualAdjustment}
                  onKeyDown={(event) => {
                    if (isSpeedAdjustmentKey(event.key)) beginSpeedVisualAdjustment();
                  }}
                  onKeyUp={(event) => {
                    if (isSpeedAdjustmentKey(event.key)) finishSpeedVisualAdjustment();
                  }}
                  aria-label="Animation speed"
                />
              </label>

              <div className="button-row">
                <button className="button button--primary" type="button" onClick={() => handlePrimaryAction()}>
                  <span className={"button-pulse " + (runState === "running" ? "button-pulse--active" : "")} aria-hidden="true" />
                  {primaryLabel}
                </button>
                {runState === "paused" && (
                  <button className="button button--secondary button--sort-new-array" type="button" onClick={() => handlePrimaryAction(true)}>
                    Sort new array
                  </button>
                )}
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
                  (algorithm === "merge" || algorithm === "powersort" ? "bars--merge " : "") +
                  (shouldInterpolateMoves ? "bars--flip bars--flip-" + motionSlideStage + " " : "") +
                  (completionSweepActive && !prefersReducedMotion ? "bars--completion-sweeping " : "") +
                  (shouldInterpolateDenseBars ? "bars--smooth" : "")
                }
                style={activeBarTransitionStyle}
                aria-hidden="true"
              >
                {renderedBarItems.map((item, index) => {
                  const height = (item.value / largestValue) * 100;
                  const slideOffset = shouldInterpolateMoves
                    ? motionSlideOffsets[item.token]
                    : undefined;
                  const slotStyle =
                    slideOffset === undefined
                      ? undefined
                      : ({ transform: "translateX(" + slideOffset + "px)" } as CSSProperties);
                  const completionScanStyle =
                    completionSweepActive && !prefersReducedMotion
                      ? ({
                          height: String(height) + "%",
                          "--completion-scan-delay": String(
                            COMPLETION_SWEEP_AUDIO_VISUAL_LEAD + index * completionSweepStepDuration,
                          ) + "ms",
                          "--completion-scan-duration": String(completionSweepStepDuration) + "ms",
                        } as CSSProperties)
                      : { height: String(height) + "%" };
                  return (
                    <div
                      className="bar-slot"
                      key={
                        shouldInterpolateMoves
                          ? "motion-" + item.token
                          : String(index) + "-" + String(originalValues.length)
                      }
                      ref={
                        shouldInterpolateMoves
                          ? (element) => setMotionBarRef(item.token, element)
                          : undefined
                      }
                      style={slotStyle}
                    >
                      <div
                        className={
                          "bar " +
                          getBarClass(index, currentStep, algorithm) +
                          (completionSweepActive && !prefersReducedMotion
                            ? " bar--completion-scan"
                            : "")
                        }
                        style={completionScanStyle}
                      >
                        {arraySize <= 24 && (
                          <span className="bar__value">{item.isGap ? "gap" : item.value}</span>
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
                {isBogo ? (
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
                ) : algorithm === "powersort" ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--run" />natural run</span>
                    <span><i className="legend__swatch legend__swatch--power" />merge decision</span>
                    <span><i className="legend__swatch legend__swatch--merge" />stable merge</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />finished row</span>
                  </>
                ) : algorithm === "quick" || algorithm === "pdq" ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />active range</span>
                    <span><i className="legend__swatch legend__swatch--key" />pivot</span>
                    <span><i className="legend__swatch legend__swatch--swap" />partition swap</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />{algorithm === "pdq" ? "safe position" : "placed pivot"}</span>
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
              <strong>
                {currentStep.pass}
                <em>{isBogo && bogoRunsUntilSolved ? " / ∞" : " / " + totalStages}</em>
              </strong>
              <p>{algorithmDetails.stageDescription}</p>
            </div>
            <div className="stat-card">
              <span>{isBogo ? "ORDER CHECKS" : "COMPARISONS"}</span>
              <strong>{currentStep.comparisons}</strong>
              <p>values checked</p>
            </div>
            <div className="stat-card">
              <span>{isBogo ? "SHUFFLE WRITES" : "ARRAY WRITES"}</span>
              <strong>{currentStep.writes}</strong>
              <p>{isBogo ? "random swaps" : "moves + writes"}</p>
            </div>
            <div className="stat-card stat-card--progress">
              <span>{isBogo && bogoRunsUntilSolved && runState !== "complete" ? "OPEN ENDED" : "PROGRESS"}</span>
              <strong>
                {isBogo && bogoRunsUntilSolved && runState !== "complete" ? "∞" : progress}
                {!(isBogo && bogoRunsUntilSolved && runState !== "complete") && <em>%</em>}
              </strong>
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

          <div className="algorithm-insights" aria-label={algorithmLabel + " benefits and trade-offs"}>
            <section
              className="algorithm-insight algorithm-insight--benefits"
              aria-labelledby={algorithm + "-benefits-title"}
            >
              <p className="eyebrow">WHY USE IT?</p>
              <h3 id={algorithm + "-benefits-title"}>Benefits</h3>
              <ul>
                {algorithmDetails.benefits.map((insight) => (
                  <li key={insight.title}>
                    <strong>{insight.title}</strong>
                    <p>{insight.copy}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section
              className="algorithm-insight algorithm-insight--tradeoffs"
              aria-labelledby={algorithm + "-tradeoffs-title"}
            >
              <p className="eyebrow">WHAT TO WATCH FOR</p>
              <h3 id={algorithm + "-tradeoffs-title"}>Shortcomings</h3>
              <ul>
                {algorithmDetails.tradeoffs.map((insight) => (
                  <li key={insight.title}>
                    <strong>{insight.title}</strong>
                    <p>{insight.copy}</p>
                  </li>
                ))}
              </ul>
            </section>
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
            {isQuickPractice && !practiceFinished && quickPivot !== null && quickActiveRange && (
              <div className="practice-quick-status" aria-label="Current Quick Sort partition">
                <span><strong>Pivot</strong> {quickPivot}</span>
                <span><strong>Working range</strong> slots {quickActiveRange[0] + 1}–{quickActiveRange[1] + 1}</span>
                <span>
                  <strong>Already fixed</strong>{" "}
                  {quickSettledValues.length ? quickSettledValues.join(", ") : "none yet"}
                </span>
              </div>
            )}
            {practiceGroups.length > 0 && (
              <div className="practice-run-guide" aria-label="Visible ordered runs in this step">
                <span className="practice-run-guide__label">RUN MAP</span>
                <ul>
                  {practiceGroups.map((group, groupIndex) => (
                    <li
                      className={
                        "practice-run-guide__item practice-run-guide__item--" +
                        group.tone +
                        (group.active ? " practice-run-guide__item--active" : "")
                      }
                      key={group.label + "-" + group.range.join("-") + "-" + groupIndex}
                      title={group.detail}
                    >
                      <span className="practice-run-guide__swatch" aria-hidden="true" />
                      <strong>{group.label}</strong>
                      <span>slots {group.range[0] + 1}–{group.range[1] + 1}</span>
                      {group.active && <em>work here</em>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="practice-lab__help">
              {isQuickPractice
                ? "The gold block is the parked pivot. Drop onto a block to swap it, or into a glowing gap to shift the row. Only the safe partition move stays, so the next pivot can never become stuck."
                : "Click two blocks or drop one directly onto another to swap them. Drop into any glowing gap to shift the row instead. The final arrangement—not which value you started with—decides whether the move stays."}
            </p>
            <div
              className={"practice-board " + (practiceDraggingId ? "practice-board--dragging" : "")}
              ref={practiceBoardRef}
              role="group"
              aria-label={algorithmLabel + " interactive practice blocks"}
            >
              {practiceValues.map((value, index) => {
                      const practiceItemId = "value-" + value;
                      const isDragging = practiceDraggingId === practiceItemId;
                      const practiceGroup = getPracticeGroupAtIndex(practiceGroups, index);
                      const isGroupStart = practiceGroup?.range[0] === index;
                      const isGroupEnd = practiceGroup?.range[1] === index;
                      const isQuickWalkthroughComplete = isQuickPractice && practiceFinished;
                      const isQuickPivot = !isQuickWalkthroughComplete && isQuickPractice && value === quickPivot;
                      const isQuickSettled = isQuickWalkthroughComplete || (!isQuickPivot && quickSettledValues.includes(value));
                      const isInQuickRange =
                        isQuickWalkthroughComplete ||
                        !isQuickPractice ||
                        !quickActiveRange ||
                        (index >= quickActiveRange[0] && index <= quickActiveRange[1]);
                      const quickLabel = isQuickWalkthroughComplete || isQuickSettled
                        ? ", fixed in its final position"
                        : isQuickPivot
                        ? ", current pivot"
                        : isQuickPractice && !isInQuickRange
                            ? ", outside the current partition"
                            : "";
                      const groupLabel = practiceGroup
                        ? ", " + practiceGroup.label + (practiceGroup.active ? ", working group" : "") +
                          (practiceGroup.detail ? ". " + practiceGroup.detail : "")
                        : "";
                      return (
                        <Fragment key={practiceItemId}>
                          <span
                            className={
                              "practice-drop-slot " +
                              (practiceDropMode === "insert" && practiceDropIndex === index && practiceDraggingId
                                ? "practice-drop-slot--target"
                                : "")
                            }
                            data-practice-drop-index={index}
                            aria-hidden="true"
                          />
                        <button
                          className={
                            "practice-block " +
                            (practiceGroup ? "practice-block--grouped practice-block--group-" + practiceGroup.tone + " " : "") +
                            (isGroupStart ? "practice-block--group-start " : "") +
                            (isGroupEnd ? "practice-block--group-end " : "") +
                            (isQuickPivot ? "practice-block--quick-pivot " : "") +
                            (isQuickSettled ? "practice-block--quick-settled " : "") +
                            (isQuickPractice && !isQuickWalkthroughComplete && isInQuickRange ? "practice-block--quick-active " : "") +
                            (isQuickPractice && !isQuickWalkthroughComplete && !isInQuickRange ? "practice-block--quick-waiting " : "") +
                            (practiceSelectedIndex === index ? "practice-block--selected " : "") +
                            (isDragging ? "practice-block--dragging " : "") +
                            (practiceDropMode === "swap" && practiceDropIndex === index && practiceDragIndex !== index
                              ? "practice-block--drop-target"
                              : "")
                          }
                          type="button"
                          key={value}
                          ref={(element) => setPracticeBlockRef(practiceItemId, element)}
                          data-practice-index={index}
                          onPointerDown={(event) => handlePracticePointerDown(event, index, practiceItemId)}
                          onPointerMove={handlePracticePointerMove}
                          onPointerUp={(event) => finishPracticeDrag(event)}
                          onPointerCancel={(event) => finishPracticeDrag(event, true)}
                          onClick={() => handlePracticeBlockClick(index)}
                          disabled={practiceUndoPending || practiceSolved}
                          aria-pressed={practiceSelectedIndex === index}
                          aria-grabbed={isDragging}
                          aria-label={"Value " + value + groupLabel + quickLabel}
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
                          <span className="practice-block__value">{value}</span>
                          {isQuickPivot && <span className="practice-block__badge">pivot</span>}
                          {isQuickSettled && <span className="practice-block__badge practice-block__badge--fixed">fixed</span>}
                        </button>
                        </Fragment>
                      );
                    })}
              <span
                className={
                  "practice-drop-slot " +
                  (practiceDropMode === "insert" && practiceDropIndex === practiceValues.length && practiceDraggingId
                    ? "practice-drop-slot--target"
                    : "")
                }
                data-practice-drop-index={practiceValues.length}
                aria-hidden="true"
              />
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
                The selected arrangement feeds the same illustrative workload model for every
                deterministic algorithm, from n=256 to n=1,048,576. Bogo Sort stays out because its
                expected work grows factorially.
              </p>
            </div>
            <div className="benchmark-controls">
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

          <div className="benchmark-tabs" role="tablist" aria-label="Efficiency Lab view">
            <button
              className={"benchmark-tab " + (benchmarkTab === "table" ? "benchmark-tab--active" : "")}
              id="efficiency-table-tab"
              type="button"
              role="tab"
              aria-selected={benchmarkTab === "table"}
              aria-controls="efficiency-table-panel"
              onClick={() => setBenchmarkTab("table")}
            >
              Work table
            </button>
            <button
              className={"benchmark-tab " + (benchmarkTab === "lines" ? "benchmark-tab--active" : "")}
              id="efficiency-lines-tab"
              type="button"
              role="tab"
              aria-selected={benchmarkTab === "lines"}
              aria-controls="efficiency-lines-panel"
              onClick={() => setBenchmarkTab("lines")}
            >
              Growth lines
            </button>
          </div>

          {benchmarkTab === "table" ? (
            <div id="efficiency-table-panel" role="tabpanel" aria-labelledby="efficiency-table-tab">
              <div
                className="benchmark-chart"
                role="img"
                aria-label={"Illustrative work growth, ordered from highest to lowest modeled work, for " + benchmarkPattern + " arrays from 256 through 1,048,576 values."}
              >
                <p className="benchmark-chart__note">
                  This view illustrates each algorithm's growth shape for the selected arrangement.
                  Meter length uses a log scale so O(n log n) curves remain visible next to quadratic
                  ones; the rounded number is a relative model unit, not a timed result or an exact
                  operation total.
                </p>
                <p className="benchmark-chart__order">
                  Rows run from most modeled work at the top to least at the bottom, based on the
                  largest n.
                </p>
                <div className="benchmark-matrix" style={benchmarkMatrixStyle}>
                  <div className="benchmark-matrix__header">
                    <span>Algorithm</span>
                    {theoreticalBenchmarkData.map((entry) => <span key={entry.size}>n={formatCount(entry.size)}</span>)}
                  </div>
                  {orderedBenchmarkAlgorithms.map((benchmarkAlgorithm) => (
                    <div className="benchmark-matrix__row" key={benchmarkAlgorithm.key}>
                      <span className="benchmark-matrix__label">
                        <i className={"benchmark-legend__swatch benchmark-legend__swatch--" + benchmarkAlgorithm.className} />
                        {benchmarkAlgorithm.label}
                      </span>
                      {theoreticalBenchmarkData.map((entry) => {
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
            </div>
          ) : (
            <div id="efficiency-lines-panel" className="growth-panel" role="tabpanel" aria-labelledby="efficiency-lines-tab">
              <div className="growth-panel__header">
                <div className="growth-panel__intro">
                  <p className="growth-panel__eyebrow">ILLUSTRATIVE MODEL · N=256–1,048,576</p>
                  <p className="growth-panel__copy">
                    Workload is on the vertical axis and array size is on the horizontal axis. Use the inspector to read exact modeled values, then zoom into nearby lines to separate them.
                  </p>
                </div>

                <div className="growth-panel__tools">
                  <label className="growth-focus-control">
                    <span>Highlight a line</span>
                    <select
                      value={growthFocusedAlgorithm}
                      onChange={(event) => handleGrowthFocusChange(event.target.value as BenchmarkAlgorithm | "all")}
                    >
                      <option value="all">All visible lines</option>
                      {BENCHMARK_ALGORITHMS.map((benchmarkAlgorithm) => (
                        <option key={benchmarkAlgorithm.key} value={benchmarkAlgorithm.key}>
                          {benchmarkAlgorithm.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="growth-zoom-controls" role="group" aria-label="Growth chart zoom controls">
                    <button
                      type="button"
                      onClick={() => setGrowthView((current) => zoomGrowthView(growthGraphDomain, current, GROWTH_GRAPH_ZOOM_STEP))}
                      aria-label="Zoom in on the growth chart"
                    >
                      Zoom in
                    </button>
                    <button
                      type="button"
                      onClick={() => setGrowthView((current) => zoomGrowthView(growthGraphDomain, current, 1 / GROWTH_GRAPH_ZOOM_STEP))}
                      aria-label="Zoom out on the growth chart"
                    >
                      Zoom out
                    </button>
                    <button type="button" onClick={resetGrowthView} aria-label="Reset growth chart zoom and pan">
                      Reset view
                    </button>
                    <span aria-label={"Current zoom " + Math.round(growthViewport.zoom * 100) + " percent"}>
                      {Math.round(growthViewport.zoom * 100)}%
                    </span>
                  </div>
                  <p className="growth-panel__gesture" id="growth-chart-help">
                    Hover or click to inspect a size. Scroll to zoom. Drag to pan. Use arrow keys when the chart is focused.
                  </p>
                </div>

                <div className="growth-toggle-list" role="group" aria-label="Algorithms shown in the growth chart">
                  {BENCHMARK_ALGORITHMS.map((benchmarkAlgorithm) => {
                    const isVisible = visibleGrowthAlgorithms[benchmarkAlgorithm.key];
                    return (
                      <button
                        className={
                          "growth-toggle " +
                          (isVisible ? "growth-toggle--active " : "") +
                          (growthFocusedAlgorithm === benchmarkAlgorithm.key ? "growth-toggle--focused" : "")
                        }
                        key={benchmarkAlgorithm.key}
                        type="button"
                        aria-pressed={isVisible}
                        onClick={() => handleGrowthAlgorithmVisibilityToggle(benchmarkAlgorithm.key)}
                        style={{ "--growth-line-color": BENCHMARK_COLORS[benchmarkAlgorithm.key] } as CSSProperties}
                      >
                        <i className={"benchmark-legend__swatch benchmark-legend__swatch--" + benchmarkAlgorithm.className} />
                        {benchmarkAlgorithm.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="growth-analysis">
                <div className="growth-chart__scroller">
                  <div
                    className={"growth-chart " + (isGrowthPanning ? "growth-chart--panning" : "")}
                    role="region"
                    tabIndex={0}
                    aria-describedby="growth-chart-help"
                    aria-label={
                      visibleGrowthSeries.length
                        ? "Interactive illustrative workload line chart with logarithmic workload and array-size axes. Showing " + visibleGrowthSeries.map((series) => series.label).join(", ") + "."
                        : "Interactive illustrative workload line chart. No algorithms are currently selected."
                    }
                    onPointerDown={handleGrowthChartPointerDown}
                    onPointerMove={handleGrowthChartPointerMove}
                    onPointerUp={finishGrowthChartPointer}
                    onPointerCancel={cancelGrowthChartPointer}
                    onPointerLeave={() => {
                      if (!growthPanRef.current) setGrowthHoverIndex(null);
                    }}
                    onWheel={handleGrowthChartWheel}
                    onKeyDown={handleGrowthChartKeyDown}
                    style={{ width: String(GROWTH_GRAPH_WIDTH) + "px", height: String(GROWTH_GRAPH_HEIGHT) + "px" }}
                  >
                    <span className="growth-chart__axis-title growth-chart__axis-title--y">WORKLOAD · LOG SCALE</span>
                    {growthGraphTicks.map((tick, index) => (
                      <Fragment key={tick.label + index}>
                        <i className="growth-chart__gridline" style={{ top: String(tick.y) + "px" }} />
                        <span className="growth-chart__y-label" style={{ top: String(tick.y) + "px" }}>{tick.label}</span>
                      </Fragment>
                    ))}
                    {visibleGrowthSeries.map((series) => (
                      <div
                        className={
                          "growth-chart__series " +
                          (series.isFocused ? "growth-chart__series--focused " : "") +
                          (growthFocusedAlgorithm !== "all" && !series.isFocused ? "growth-chart__series--dimmed" : "")
                        }
                        key={series.key}
                        aria-hidden="true"
                        style={{ "--growth-line-color": series.color } as CSSProperties}
                      >
                        {series.points.slice(0, -1).map((point, index) => {
                          const nextPoint = series.points[index + 1];
                          const deltaX = nextPoint.x - point.x;
                          const deltaY = nextPoint.y - point.y;
                          const length = Math.hypot(deltaX, deltaY);
                          const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
                          return (
                            <i
                              className="growth-chart__segment"
                              key={point.size}
                              style={{
                                left: String(point.x) + "px",
                                top: String(point.y) + "px",
                                width: String(length) + "px",
                                transform: "translateY(-50%) rotate(" + String(angle) + "deg)",
                              }}
                            />
                          );
                        })}
                        {series.points.map((point) => (
                          <i
                            className="growth-chart__point"
                            key={point.size}
                            title={series.label + ": n=" + formatCount(point.size) + ", " + formatCount(point.work) + " modeled work"}
                            style={{ left: String(point.x) + "px", top: String(point.y) + "px" }}
                          />
                        ))}
                      </div>
                    ))}
                    {growthInspection.isVisible && visibleGrowthSeries.length > 0 && (
                      <>
                        <i className="growth-chart__crosshair" style={{ left: String(growthInspection.x) + "px" }} />
                        <span className="growth-chart__crosshair-label" style={{ left: String(growthInspection.x) + "px" }}>
                          n={formatGrowthSize(growthInspection.size)}
                        </span>
                      </>
                    )}
                    {theoreticalBenchmarkData.map((entry, index) => {
                      const normalizedX = index / Math.max(theoreticalBenchmarkData.length - 1, 1);
                      const x = GROWTH_GRAPH_PLOT_LEFT +
                        ((normalizedX - growthViewport.xStart) / growthViewport.xSpan) * GROWTH_GRAPH_PLOT_WIDTH;
                      return (
                        <Fragment key={entry.size}>
                          <i className="growth-chart__x-gridline" style={{ left: String(x) + "px" }} />
                          <span
                            className="growth-chart__x-label"
                            title={"n=" + formatCount(entry.size)}
                            style={{ left: String(x) + "px" }}
                          >
                            {formatGrowthSize(entry.size)}
                          </span>
                        </Fragment>
                      );
                    })}
                    <span className="growth-chart__axis-title growth-chart__axis-title--x">ARRAY SIZE, N · LOG SCALE</span>
                    {visibleGrowthSeries.length === 0 && (
                      <p className="growth-chart__empty">Select an algorithm above to draw its workload line.</p>
                    )}
                  </div>
                </div>

                <aside className="growth-inspector" aria-label={"Modeled workload at n=" + formatCount(growthInspection.size)}>
                  <p className="growth-inspector__eyebrow">READOUT AT N={formatGrowthSize(growthInspection.size)}</p>
                  <strong>{formatCount(growthInspection.size)} values</strong>
                  <p>Exact modeled work makes similar-looking curves easier to compare.</p>
                  {growthInspection.rows.length ? (
                    <ol className="growth-inspector__list">
                      {growthInspection.rows.map((row) => (
                        <li
                          key={row.key}
                          className={growthFocusedAlgorithm === row.key ? "growth-inspector__row--focused" : ""}
                          style={{ "--growth-line-color": row.color } as CSSProperties}
                        >
                          <span>
                            <i className={"benchmark-legend__swatch benchmark-legend__swatch--" + row.className} />
                            {row.label}
                          </span>
                          <strong>{formatCount(row.work)}</strong>
                          <small>
                            {row.multiplier === 1 ? "fastest active line" : formatGrowthMultiplier(row.multiplier) + " the fastest"}
                          </small>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="growth-inspector__empty">Turn on an algorithm to inspect its modeled work.</p>
                  )}
                </aside>
              </div>
            </div>
          )}
        </section>

        <p className="sr-only" aria-live="polite" aria-atomic="true">{liveStatus}</p>
      </div>
    </main>
  );
}
