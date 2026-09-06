import {
  Fragment,
  memo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useInsertionEffect,
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
  isPreparedInsertionKeyPlacement,
  isPracticeRowFinished,
  isPracticeMoveProgress,
  prepareInsertionKeyDrop,
  resolvePracticeDropTarget,
  shufflePracticeValues,
  type PracticeDropMode,
  type PracticeDropRegion,
  type PracticeDropTarget,
} from "./lib/practice";
import {
  createSmallArrayPianoToneMap,
  decodePcmWav,
  getContinuousToneFrequency,
  getDenseTonePulseWindow,
  getSafeScheduledAudioTime,
  isCompletionSweepAudioFinished,
  usesContinuousDenseTone,
  type DecodedPcmWav,
} from "./lib/audio";
import {
  makeArrayForArrangement,
  type ArrayArrangement,
} from "./lib/array-arrangements";
import type {
  BogoWorkerEvent,
  BogoWorkerPacing,
} from "./lib/bogo-worker-protocol";

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

// Keep the learning path in one place so the hero's previous/next controls
// and its direct-picker menu always agree on the same progression.
const ALGORITHM_ORDER: readonly AlgorithmId[] = [
  "bogo",
  "selection",
  "insertion",
  "bubble",
  "cocktail",
  "heap",
  "quick",
  "pdq",
  "merge",
  "powersort",
];

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
type BenchmarkTab = "table" | "bars";
type AlgorithmCardTab = "walkthrough" | "python";
type IntroPhase = "visible" | "exiting" | "hidden";
type BogoPracticeCasinoSound = "entry" | "shuffle" | "fail" | "success";
type WorkloadBarTransitionMap = Partial<Record<BenchmarkAlgorithm, number>>;
type AudioContextConstructor = new () => AudioContext;

// Older Apple WebKit hosts can expose the constructor under this prefixed
// name. Tauri's macOS webview is modern today, but accepting both costs
// nothing and keeps the sound engine portable across supported WKWebViews.
type AudioContextWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };

type DenseLiveToneVoice = {
  context: AudioContext;
  oscillator: OscillatorNode;
  filter: BiquadFilterNode;
  pulseEnvelope: GainNode;
  releaseEnvelope: GainNode;
  lastPulseEndTime: number;
};

type CompletionSweepAudioRun = {
  id: number;
  context: AudioContext;
  output: GainNode;
  sources: Set<OscillatorNode>;
  pendingVoiceCount: number;
  schedulingComplete: boolean;
  released: boolean;
};

type ActiveBogoWorkerRun = {
  runId: number;
  hasSnapshot: boolean;
};

type PendingBogoWorkerRateCalibration = {
  runId: number;
  configurationId: number;
  modeledShuffleRate: number;
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
  /** Require this exact resulting row for a concept with one safe next move. */
  validation?: "exact" | "progress";
  /** The highlighted pivot for a partition lesson. */
  pivot?: number;
  /** Whether the pivot was parked or chosen from a PDQ median-of-three sample. */
  pivotKind?: "parked" | "sampled";
  /** Values PDQ inspected when it chose a sampled pivot. */
  sampleValues?: number[];
  /** The highlighted key for an insertion-style lesson. */
  insertingKey?: number;
  /** Inclusive indices for the part of the row currently being worked on. */
  activeRange?: [number, number];
  /** Values whose positions are already certified by the current rule. */
  settled?: number[];
  /** Short status copy for PDQ's adaptive guard or Powersort's merge schedule. */
  decision?: {
    label: string;
    detail: string;
    power?: number;
  };
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
  /** The current Quick Sort pivot's array slot for renderer-only emphasis. */
  pivotIndex?: number;
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

// The initial Bogo demo should be small enough to understand at a glance.
// Keep DEFAULT_ARRAY_SIZE separate because it also marks the point where a
// number of visual and pacing optimizations begin.
const INITIAL_ARRAY_SIZE = 4;
const DEFAULT_ARRAY_SIZE = 24;
const DEFAULT_SPEED = 50;
// The interface stays on a familiar 1–100% scale while deterministic sorts
// keep the wider playback range that makes the top end feel responsive.
const MAX_SPEED = 200;
const DISPLAY_SPEED_MAX = 100;
const MOVE_INTERPOLATION_MAX_SPEED = 50;
const BOGO_MAX_ARRAY_SIZE = 25;
// A dense, bar-only verification scan needs enough time for the eye to read
// the order, but not so much that a 256-value finish becomes its own scene.
const COMPLETION_SWEEP_MIN_DURATION = 425;
const COMPLETION_SWEEP_MILLISECONDS_PER_BAR = 5;
const COMPLETION_SWEEP_AUDIO_VISUAL_LEAD = 24;
const COMPLETION_SWEEP_RELEASE_TAIL = 70;
const COMPLETION_SWEEP_OUTPUT_RELEASE_SECONDS = 0.018;
const LIVE_TONE_OUTPUT_RELEASE_SECONDS = 0.018;
const AUDIO_SOURCE_STOP_PADDING_SECONDS = 0.008;
const MAX_LIVE_TONE_SOURCES = 16;
// Give dense Web Audio voices a full native-output safety margin before a
// control point reaches the render quantum. An 8 ms lead was enough in a
// browser tab, but desktop WebKit can miss that window while its renderer is
// busy and then repeatedly cancel/rewrite in-flight automation.
const DENSE_TONE_SCHEDULE_LEAD_SECONDS = 0.032;
// Dense rows reuse one silent oscillator internally, but every audible event
// remains a discrete burst. A short attack/release prevents clicks, and the
// explicit quiet gap stops fast playback from smearing into one long tone.
const DENSE_TONE_PULSE_ATTACK_SECONDS = 0.006;
const DENSE_TONE_PULSE_HOLD_SECONDS = 0.006;
const DENSE_TONE_PULSE_RELEASE_SECONDS = 0.018;
const DENSE_TONE_MIN_SILENCE_SECONDS = 0.024;
// Above this size the learning value comes from the changing order and
// highlights, not from keeping a separate DOM element for every value. A
// canvas gives WebKit one composited surface instead of 64–256 independently
// styled gradient boxes every playback frame. Keep the regular DOM/FLIP path
// for smaller rows and careful slow-motion inspection.
const CANVAS_BAR_RENDERER_MIN_ARRAY_SIZE = 64;
const DENSE_CANVAS_MAX_PIXEL_RATIO = 1.5;
// A full React tree and 256 bar nodes cannot be repainted meaningfully more
// than about 30 times per second on every desktop WebView. At the fastest
// settings, advance several already-recorded algorithm steps per paint rather
// than asking macOS/Linux/Windows to render a frame for every tiny mutation.
const DENSE_PLAYBACK_FRAME_INTERVAL = 32;
// Dense canvas playback publishes audible/status milestones independently of
// React. The page only commits the exact index at a semantic boundary (pause,
// renderer handoff, or completion), avoiding a full teaching-page reconciliation
// every 80ms on desktop WebViews.
const BOGO_COMPLETION_SWEEP_DELAY = 720;
// Keep the win message on screen long enough to read, then let its exit
// animation finish before removing it from the DOM.
const BOGO_CELEBRATION_VISIBLE_DURATION = 4_800;
const BOGO_CELEBRATION_FADE_DURATION = 560;
// Lessons get the same satisfying, compact payoff as a successful Bogo run,
// without the Bogo-specific message. Keep it short so restarting a lesson is
// never held up by its celebration.
const PRACTICE_CELEBRATION_VISIBLE_DURATION = 1_350;
const PRACTICE_CELEBRATION_FADE_DURATION = 560;
const SORTSCOPE_INTRO_SESSION_KEY = "sortscope-intro-seen";
const SORTSCOPE_INTRO_EXIT_DURATION = 360;
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
const DEFAULT_WORKLOAD_BAR_ALGORITHM_VISIBILITY: Record<BenchmarkAlgorithm, boolean> = {
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
const BOGO_MIN_ATTEMPTS = 1;
const BOGO_STANDARD_MAX_ATTEMPTS = 999_999_999;
// The hands-on Bogo experiment deliberately stays tiny: every click gives
// all 4! possible orders an equal chance, so a lucky completion is possible
// without borrowing the Control Room's potentially enormous input.
const BOGO_PRACTICE_INITIAL_VALUES = [4, 2, 1, 3];
const BOGO_PRACTICE_ROLL_INTERVAL = 52;
// The supplied casino clips are mastered a little hotter than the synthesized
// sort tones. Play them at 35% of the selected master volume at every slider
// setting, while preserving the slider's full 0–100% behavior.
const BOGO_PRACTICE_CASINO_GAIN = 0.35;
// Native media can take a moment to begin under load. Once a clip has actually
// started, it is always allowed to reach its own `ended` event; this watchdog
// only gives a genuinely unavailable player a graceful, timed visual fallback.
const BOGO_PRACTICE_CASINO_STARTUP_TIMEOUT = 12_000;
const BOGO_PRACTICE_CASINO_SOUNDS: Record<
  BogoPracticeCasinoSound,
  { source: string; silentDuration: number }
> = {
  entry: { source: `${import.meta.env.BASE_URL}audio/bogo-casino-gambling.wav`, silentDuration: 1_800 },
  shuffle: { source: `${import.meta.env.BASE_URL}audio/bogo-casino-shuffle.wav`, silentDuration: 700 },
  fail: { source: `${import.meta.env.BASE_URL}audio/bogo-casino-fail.wav`, silentDuration: 1_500 },
  success: { source: `${import.meta.env.BASE_URL}audio/bogo-casino-success.wav`, silentDuration: 2_200 },
};
// At the top end, the live runner works in short CPU batches. This is a
// deliberately conservative pre-run model; the page replaces it with the
// browser's measured rate once a Bogo session has run long enough to sample.
const BOGO_FAST_ESTIMATED_SHUFFLES_PER_SECOND = 2_500_000;
const BOGO_RATE_SAMPLE_INTERVAL = 250;
const BOGO_EXPECTED_RATE_FREEZE_AFTER = 2_500;
// A fast Bogo run is deliberately CPU-heavy, but it must still return to the
// desktop WebView often enough to paint and accept pause/reset input.
const BOGO_FAST_BATCH_BUDGET_MILLISECONDS = 8;
const BOGO_FAST_COOPERATIVE_YIELD_MILLISECONDS = 34;
const BOGO_WORKER_STARTUP_TIMEOUT = 1_000;
// Fast Bogo batches can execute several times between display refreshes. Keep
// the simulation hot, but only snapshot its mutable session at a readable
// cadence; each snapshot otherwise re-renders the entire teaching surface.
const BOGO_VISUAL_UPDATE_INTERVAL = 50;
// A small buffer makes a direct block drop forgiving without swallowing the
// dedicated gap that sits between adjacent blocks.
const PRACTICE_DIRECT_DROP_HIT_SLOP = 8;
const INITIAL_VALUES = [4, 2, 1, 3];
const BOGO_CONFETTI_COLORS = ["#ffe98e", "#a9f2be", "#8ee6ff", "#cbb8ff", "#ff9fba", "#ffbd82"];
const BOGO_CONFETTI = Array.from({ length: 64 }, (_, index) => ({
  id: index,
  left: (index * 37 + 11) % 100,
  delay: (index % 16) * 0.07,
  duration: 1.8 + (index % 5) * 0.18,
  color: BOGO_CONFETTI_COLORS[index % BOGO_CONFETTI_COLORS.length],
  shape: index % 3,
}));

function getInitialIntroPhase(): IntroPhase {
  if (typeof window === "undefined") return "visible";

  try {
    return window.sessionStorage.getItem(SORTSCOPE_INTRO_SESSION_KEY) === "seen"
      ? "hidden"
      : "visible";
  } catch {
    // Storage can be unavailable in private or embedded contexts. In that
    // case the welcome screen still works for this page view.
    return "visible";
  }
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
    learnTitle: "Like sorting cards in your hand",
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
      { title: "Excellent when nearly ordered", copy: "It leaves the sorted left side alone and shifts only the values that are out of place." },
      { title: "Small and stable", copy: "It works in the original row and keeps equal values in their original order." },
    ],
    tradeoffs: [
      { title: "Long slides add up", copy: "A small value near the end may have to travel past many earlier values." },
      { title: "Not for heavy disorder", copy: "A large shuffled row creates so many shifts that faster divide-and-conquer sorts usually win." },
    ],
    practice: [
      {
        prompt: "Hold 1 as the key. 4 and 5 shift right automatically—drop 1 into the open gap.",
        start: [4, 5, 1, 2, 3, 6],
        target: [1, 4, 5, 2, 3, 6],
        insertingKey: 1,
        activeRange: [0, 2],
        validation: "exact",
        hint: "The automatic shifts opened the first slot. Place the held yellow 1 directly into that gap.",
      },
      {
        prompt: "Now hold 2 as the key. 4 and 5 shift right automatically—place 2 in its open gap.",
        start: [1, 4, 5, 2, 3, 6],
        target: [1, 2, 4, 5, 3, 6],
        insertingKey: 2,
        activeRange: [1, 3],
        validation: "exact",
        hint: "2 belongs after 1. The shifted 4 and 5 leave one glowing gap exactly there.",
      },
      {
        prompt: "Finish with 3 as the key. 4 and 5 shift right automatically; drop 3 into the last open gap.",
        start: [1, 2, 4, 5, 3, 6],
        target: [1, 2, 3, 4, 5, 6],
        insertingKey: 3,
        activeRange: [2, 4],
        validation: "exact",
        hint: "The only empty slot is between 2 and 4. Drop the held yellow 3 there to finish the row.",
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
    learnTitle: "Let one large value rise at a time",
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
        prompt: "Begin the first forward sweep: swap the backwards neighbors 4 and 1.",
        start: [4, 1, 6, 3, 2, 5],
        target: [1, 4, 6, 3, 2, 5],
        validation: "exact",
        hint: "Bubble Sort only trades neighboring values. 4 is larger than its right neighbor, 1.",
      },
      {
        prompt: "Keep scanning right. 6 is larger than 3, so it bubbles one place right.",
        start: [1, 4, 6, 3, 2, 5],
        target: [1, 4, 3, 6, 2, 5],
        validation: "exact",
        hint: "The pair 4 and 6 is already fine. Continue to the next neighboring pair, 6 and 3.",
      },
      {
        prompt: "The same 6 meets 2 next. Swap that neighboring pair and keep its trip going.",
        start: [1, 4, 3, 6, 2, 5],
        target: [1, 4, 3, 2, 6, 5],
        validation: "exact",
        hint: "6 can travel across this pass only by one neighboring swap at a time.",
      },
      {
        prompt: "Finish the first sweep: swap 6 and 5, locking 6 at the far right.",
        start: [1, 4, 3, 2, 6, 5],
        target: [1, 4, 3, 2, 5, 6],
        validation: "exact",
        hint: "After a complete left-to-right sweep, the largest unsorted value must be at the right edge.",
      },
      {
        prompt: "Start the shorter second sweep. Swap the backwards neighbors 4 and 3.",
        start: [1, 4, 3, 2, 5, 6],
        target: [1, 3, 4, 2, 5, 6],
        validation: "exact",
        hint: "6 is fixed, so this pass stops before it. Continue comparing only neighboring values to its left.",
      },
      {
        prompt: "Continue the second sweep: 4 is still larger than 2.",
        start: [1, 3, 4, 2, 5, 6],
        target: [1, 3, 2, 4, 5, 6],
        validation: "exact",
        hint: "Swap this adjacent backwards pair; 4 now reaches its settled position before 5 and 6.",
      },
      {
        prompt: "One final neighboring swap in the remaining three slots completes the row.",
        start: [1, 3, 2, 4, 5, 6],
        target: [1, 2, 3, 4, 5, 6],
        validation: "exact",
        hint: "3 and 2 are the only backwards neighbors left. Bubble Sort finishes when a pass has no swaps.",
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
    learnTitle: "Shake it like a Polaroid picture",
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
        prompt: "Forward sweep: 5 meets 1, so move the larger value one neighbor to the right.",
        start: [3, 4, 5, 1, 2, 6, 8, 7],
        target: [3, 4, 1, 5, 2, 6, 8, 7],
        validation: "exact",
        hint: "The first two pairs are already ordered. Cocktail Sort keeps scanning until it finds the backward neighboring pair 5 and 1.",
      },
      {
        prompt: "Stay on the forward sweep: 5 now meets 2 and keeps moving right.",
        start: [3, 4, 1, 5, 2, 6, 8, 7],
        target: [3, 4, 1, 2, 5, 6, 8, 7],
        validation: "exact",
        hint: "On the rightward trip, a large value can keep bubbling through several neighboring swaps in one pass.",
      },
      {
        prompt: "Finish the forward sweep at the far edge: swap 8 and 7, so 8 is fixed on the right.",
        start: [3, 4, 1, 2, 5, 6, 8, 7],
        target: [3, 4, 1, 2, 5, 6, 7, 8],
        validation: "exact",
        hint: "8 is the largest value. Reaching the right edge proves it will never need to move again.",
      },
      {
        prompt: "Turn around. On the backward sweep, carry the small value 1 left through 4.",
        start: [3, 4, 1, 2, 5, 6, 7, 8],
        target: [3, 1, 4, 2, 5, 6, 7, 8],
        validation: "exact",
        hint: "Now comparisons move right-to-left, so small values can travel left immediately instead of waiting for another full pass.",
      },
      {
        prompt: "Keep the backward sweep going: move 1 left through 3 and lock the left edge.",
        start: [3, 1, 4, 2, 5, 6, 7, 8],
        target: [1, 3, 4, 2, 5, 6, 7, 8],
        validation: "exact",
        hint: "The backward pass has now settled 1 at the opposite edge from 8. That is Cocktail Sort's two-way advantage.",
      },
      {
        prompt: "Start the smaller middle sweep: 4 moves right through 2.",
        start: [1, 3, 4, 2, 5, 6, 7, 8],
        target: [1, 3, 2, 4, 5, 6, 7, 8],
        validation: "exact",
        hint: "Both edges are fixed, so only the middle is still active. Continue the forward rule on the neighboring pair 4 and 2.",
      },
      {
        prompt: "The middle is almost done. Swap 3 and 2 to finish the eight-value row.",
        start: [1, 3, 2, 4, 5, 6, 7, 8],
        target: [1, 2, 3, 4, 5, 6, 7, 8],
        validation: "exact",
        hint: "Cocktail Sort shrinks inward from both ends after every forward-and-backward pair of sweeps.",
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
    learnTitle: "Choose the next spot deliberately",
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
    learnTitle: "Keep the largest value on top",
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
        validation: "exact",
        hint: "The root must be at least as large as both of its children.",
      },
      {
        prompt: "Extract the root: move 6 directly to the far-right finished slot.",
        start: [6, 4, 5, 2, 3, 1],
        target: [1, 4, 5, 2, 3, 6],
        validation: "exact",
        hint: "An extraction is one swap: trade the root 6 with the last active slot, 1. Do not slide it through intermediate positions.",
      },
      {
        prompt: "Sift the new root down: move the larger child, 5, above 1.",
        start: [1, 4, 5, 2, 3, 6],
        target: [5, 4, 1, 2, 3, 6],
        validation: "exact",
        hint: "Compare the root's children 4 and 5; the larger child is 5, so it swaps with the root in one move.",
      },
      {
        prompt: "Extract 5 to its next finished slot.",
        start: [5, 4, 1, 2, 3, 6],
        target: [3, 4, 1, 2, 5, 6],
        validation: "exact",
        hint: "Swap the root 5 directly with the last active value, 3. The right side [5, 6] is now fixed.",
      },
      {
        prompt: "Restore the four-value heap by sifting 4 above its temporary root, 3.",
        start: [3, 4, 1, 2, 5, 6],
        target: [4, 3, 1, 2, 5, 6],
        validation: "exact",
        hint: "4 is the larger root child, so it takes the root position in one direct swap.",
      },
      {
        prompt: "Extract 4 to the next finished slot.",
        start: [4, 3, 1, 2, 5, 6],
        target: [2, 3, 1, 4, 5, 6],
        validation: "exact",
        hint: "Swap the root 4 directly with the last active slot, 2.",
      },
      {
        prompt: "Sift 3 back to the root of the remaining three-value heap.",
        start: [2, 3, 1, 4, 5, 6],
        target: [3, 2, 1, 4, 5, 6],
        validation: "exact",
        hint: "3 is the larger child of 2, so it must return to the root before the next extraction.",
      },
      {
        prompt: "Extract 3 directly to finish the six-value row.",
        start: [3, 2, 1, 4, 5, 6],
        target: [1, 2, 3, 4, 5, 6],
        validation: "exact",
        hint: "Swap the root 3 with the final active slot, 1. The remaining pair is already ordered.",
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
    learnTitle: "Put pivots in their final places",
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
        prompt: "Pivot 3 is parked on the right. Move the smaller value 1 into the first open spot on its left side.",
        start: [6, 1, 7, 4, 8, 2, 5, 3],
        target: [1, 6, 7, 4, 8, 2, 5, 3],
        pivot: 3,
        activeRange: [0, 7],
        settled: [],
        hint: "1 is no larger than pivot 3, so trade it with the first value, 6. Leave the highlighted pivot parked for now.",
      },
      {
        prompt: "Keep pivot 3 parked. Move 2 into the next open spot on its smaller-value side.",
        start: [1, 6, 7, 4, 8, 2, 5, 3],
        target: [1, 2, 7, 4, 8, 6, 5, 3],
        pivot: 3,
        activeRange: [0, 7],
        settled: [],
        hint: "2 also belongs before 3. Swap 2 with 6, the next value in the not-yet-partitioned area.",
      },
      {
        prompt: "Place pivot 3 directly after 1 and 2. Its position becomes permanent.",
        start: [1, 2, 7, 4, 8, 6, 5, 3],
        target: [1, 2, 3, 4, 8, 6, 5, 7],
        pivot: 3,
        activeRange: [0, 7],
        settled: [1, 2],
        hint: "Swap the highlighted pivot 3 with 7. Everything left of it is smaller; everything right is larger.",
      },
      {
        prompt: "The left side is finished. In the right range, pivot 7 is parked on the right—move 6 into the next open smaller-value spot.",
        start: [1, 2, 3, 4, 8, 6, 5, 7],
        target: [1, 2, 3, 4, 6, 8, 5, 7],
        pivot: 7,
        activeRange: [3, 7],
        settled: [1, 2, 3],
        hint: "4 is already in the smaller area. Move 6 beside it by swapping 6 with 8, the next value in the not-yet-partitioned area.",
      },
      {
        prompt: "Keep pivot 7 parked. Move 5 into the final open spot on its smaller-value side.",
        start: [1, 2, 3, 4, 6, 8, 5, 7],
        target: [1, 2, 3, 4, 6, 5, 8, 7],
        pivot: 7,
        activeRange: [3, 7],
        settled: [1, 2, 3],
        hint: "5 belongs before 7. Swap it with 8 to finish pivot 7's smaller-value side [4, 6, 5].",
      },
      {
        prompt: "Place pivot 7 immediately after 4, 6, and 5. That locks the next pivot position.",
        start: [1, 2, 3, 4, 6, 5, 8, 7],
        target: [1, 2, 3, 4, 6, 5, 7, 8],
        pivot: 7,
        activeRange: [3, 7],
        settled: [1, 2, 3],
        hint: "Swap the highlighted pivot 7 with 8. Everything left of it is smaller, and 8 is fixed on its right.",
      },
      {
        prompt: "Only [4, 6, 5] remains. Pivot 5 is parked on the right—place it between 4 and 6 to finish the row.",
        start: [1, 2, 3, 4, 6, 5, 7, 8],
        target: [1, 2, 3, 4, 5, 6, 7, 8],
        pivot: 5,
        activeRange: [3, 5],
        settled: [1, 2, 3, 7, 8],
        hint: "4 is already on pivot 5's smaller side. Swap the highlighted 5 with 6 to finish Quick Sort.",
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
    learnTitle: "Find order in the chaos",
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
        prompt: "PDQ samples the first, middle, and last values: 8, 3, and 4. Their middle value is 4, so park 4 as the sampled pivot.",
        start: [8, 1, 7, 3, 6, 2, 5, 4],
        target: [4, 1, 7, 3, 6, 2, 5, 8],
        pivot: 4,
        pivotKind: "sampled",
        sampleValues: [8, 3, 4],
        activeRange: [0, 7],
        validation: "exact",
        decision: {
          label: "Sampled pivot",
          detail: "PDQ uses the median of the endpoint and midpoint samples: median(8, 3, 4) = 4.",
        },
        hint: "Swap the sampled pivot 4 with 8. The gold pivot stays visible while its branch is partitioned.",
      },
      {
        prompt: "Use the sampled pivot 4 as a fence: move 2 into the low side so the branch splits into two balanced four-value groups.",
        start: [4, 1, 7, 3, 6, 2, 5, 8],
        target: [4, 1, 2, 3, 6, 7, 5, 8],
        pivot: 4,
        pivotKind: "sampled",
        sampleValues: [8, 3, 4],
        activeRange: [0, 7],
        validation: "exact",
        decision: {
          label: "Healthy split",
          detail: "Four values now sit on each side of the fence, so PDQ keeps its quick partition rhythm instead of breaking a pattern.",
        },
        groups: [
          { range: [0, 3], label: "low partition", detail: "values no larger than the sampled fence", tone: "cyan", active: true },
          { range: [4, 7], label: "high partition", detail: "values larger than the sampled fence", tone: "violet", active: true },
        ],
        hint: "2 belongs on the low side. Swap it with 7; the resulting row creates a visible 4 | 4 split.",
      },
      {
        prompt: "On the high side, PDQ samples 6, 7, and 8. Its middle value is 7; move 5 below that sampled pivot.",
        start: [4, 1, 2, 3, 6, 7, 5, 8],
        target: [4, 1, 2, 3, 6, 5, 7, 8],
        pivot: 7,
        pivotKind: "sampled",
        sampleValues: [6, 7, 8],
        activeRange: [4, 7],
        settled: [4],
        validation: "exact",
        decision: {
          label: "Second sampled pivot",
          detail: "median(6, 7, 8) = 7. This keeps the next branch from inheriting an awkward edge pivot.",
        },
        groups: [
          { range: [0, 3], label: "certified low partition", detail: "leave this four-value branch alone", tone: "cyan" },
          { range: [4, 7], label: "high partition", detail: "work around its new sampled pivot", tone: "violet", active: true },
        ],
        hint: "5 is smaller than pivot 7. Swap it with 7 to make the short high-side branch easier to clean up.",
      },
      {
        prompt: "This left branch is now tiny, so PDQ stops partitioning and uses its small-piece insertion cleanup.",
        start: [4, 1, 2, 3, 6, 5, 7, 8],
        target: [1, 2, 3, 4, 6, 5, 7, 8],
        activeRange: [0, 3],
        settled: [7, 8],
        validation: "exact",
        decision: {
          label: "Tiny-piece cleanup",
          detail: "Real PDQ branches of 16 or fewer values use insertion sort rather than spending more time choosing pivots.",
        },
        groups: [
          { range: [0, 3], label: "tiny cleanup branch", detail: "finish this short piece with one insertion move", tone: "gold", active: true },
          { range: [4, 7], label: "remaining branch", detail: "already close to ordered", tone: "violet" },
        ],
        hint: "Move 4 from the front into the gap after 3. This is an insertion-style move, not a new full partition.",
      },
      {
        prompt: "Finish the last tiny cleanup: insert 5 before 6. The branch and the whole lesson are now sorted.",
        start: [1, 2, 3, 4, 6, 5, 7, 8],
        target: [1, 2, 3, 4, 5, 6, 7, 8],
        activeRange: [4, 5],
        settled: [1, 2, 3, 4, 7, 8],
        validation: "exact",
        decision: {
          label: "Tiny-piece cleanup",
          detail: "PDQ uses the simplest effective tool once only a small, nearly ordered piece remains.",
        },
        hint: "Place 5 directly before 6. The finished-row check will complete the walkthrough.",
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
    learnTitle: "Combine sorted pieces",
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
          { range: [0, 3], label: "working four-value group", detail: "merge these two ordered pairs into one four-value run", tone: "cyan", active: true },
          { range: [4, 7], label: "waiting four-value group", detail: "this second pair of ordered pairs merges next", tone: "violet" },
        ],
      },
      {
        prompt: "Merge [3, 7] with [4, 8] into the other four-value run.",
        start: [1, 2, 5, 6, 3, 7, 4, 8],
        target: [1, 2, 5, 6, 3, 4, 7, 8],
        hint: "4 needs to come before 7 while the completed left run stays untouched.",
        groups: [
          { range: [0, 3], label: "ready four-value run", detail: "this merged run is already in order", tone: "cyan" },
          { range: [4, 7], label: "working four-value group", detail: "merge these two ordered pairs into one four-value run", tone: "violet", active: true },
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
    learnTitle: "Build from the order that is already there",
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
        prompt: "Discover the first short falling run B, then flip [6, 2] into the rising run [2, 6].",
        start: [1, 5, 9, 11, 12, 6, 2, 8, 4, 10, 7, 3],
        target: [1, 5, 9, 11, 12, 2, 6, 8, 4, 10, 7, 3],
        validation: "exact",
        decision: {
          label: "Run discovery",
          detail: "A is already rising. B is falling, so Powersort reverses only that local run before planning any merge.",
        },
        hint: "Swap the two values in the highlighted B run. The long rising run A stays untouched.",
        groups: [
          { range: [0, 4], label: "run A", detail: "already rising: [1, 5, 9, 11, 12]", tone: "cyan" },
          { range: [5, 6], label: "run B", detail: "falling: reverse it into [2, 6]", tone: "violet", active: true },
          { range: [7, 8], label: "run C", detail: "a later short falling run", tone: "mint" },
          { range: [9, 11], label: "run D", detail: "a later falling run", tone: "gold" },
        ],
      },
      {
        prompt: "Discover run C next: flip [8, 4] into its rising form [4, 8].",
        start: [1, 5, 9, 11, 12, 2, 6, 8, 4, 10, 7, 3],
        target: [1, 5, 9, 11, 12, 2, 6, 4, 8, 10, 7, 3],
        validation: "exact",
        decision: {
          label: "Run discovery",
          detail: "Powersort preserves A and B, then turns C into an increasing run it can safely merge later.",
        },
        hint: "Reverse only C's two values. Do not start merging runs yet.",
        groups: [
          { range: [0, 4], label: "run A", detail: "ready rising run", tone: "cyan" },
          { range: [5, 6], label: "run B", detail: "ready rising run", tone: "violet" },
          { range: [7, 8], label: "run C", detail: "falling: reverse it into [4, 8]", tone: "mint", active: true },
          { range: [9, 11], label: "run D", detail: "will be prepared last", tone: "gold" },
        ],
      },
      {
        prompt: "Discover the final run D: reverse its falling stretch [10, 7, 3] into [3, 7, 10].",
        start: [1, 5, 9, 11, 12, 2, 6, 4, 8, 10, 7, 3],
        target: [1, 5, 9, 11, 12, 2, 6, 4, 8, 3, 7, 10],
        validation: "exact",
        decision: {
          label: "Run discovery",
          detail: "Now Powersort has four naturally ordered runs of deliberately uneven lengths, ready for its power-based plan.",
        },
        hint: "Reverse this three-value falling run by moving 3 to its front. That completes run discovery.",
        groups: [
          { range: [0, 4], label: "run A", detail: "ready rising run", tone: "cyan" },
          { range: [5, 6], label: "run B", detail: "ready rising run", tone: "violet" },
          { range: [7, 8], label: "run C", detail: "ready rising run", tone: "mint" },
          { range: [9, 11], label: "run D", detail: "falling: reverse it into [3, 7, 10]", tone: "gold", active: true },
        ],
      },
      {
        prompt: "Powersort measures the boundaries. Power 3 is deepest, so merge B and C first—not the leftmost pair.",
        start: [1, 5, 9, 11, 12, 2, 6, 4, 8, 3, 7, 10],
        target: [1, 5, 9, 11, 12, 2, 4, 6, 8, 3, 7, 10],
        validation: "exact",
        decision: {
          power: 3,
          label: "Merge B + C first",
          detail: "Power 3 is the deepest pending boundary, so it outranks the earlier-looking A/B boundary with power 1.",
        },
        hint: "Swap 6 and 4 to begin the local B+C merge. A stays on the left, waiting for the lowest-power final merge.",
        groups: [
          { range: [0, 4], label: "run A", detail: "waits for the final merge", tone: "cyan" },
          { range: [5, 8], label: "B + C merge", detail: "highest-power boundary: work here first", tone: "violet", active: true },
          { range: [9, 11], label: "run D", detail: "waits for the next merge", tone: "gold" },
        ],
      },
      {
        prompt: "Next comes power 2: merge the combined B+C run with D, leaving the long run A for later.",
        start: [1, 5, 9, 11, 12, 2, 4, 6, 8, 3, 7, 10],
        target: [1, 5, 9, 11, 12, 2, 3, 4, 6, 7, 8, 10],
        decision: {
          power: 2,
          label: "Merge B+C + D",
          detail: "The next-deepest boundary wins. This deliberately differs from Merge Sort's fixed pair-by-pair schedule.",
        },
        hint: "Bring 3 into the combined right-side run first, then continue moving its next smaller values forward. Each helpful local move stays.",
        groups: [
          { range: [0, 4], label: "run A", detail: "still waits for the root merge", tone: "cyan" },
          { range: [5, 11], label: "B + C + D merge", detail: "power 2: combine these uneven runs now", tone: "violet", active: true },
        ],
      },
      {
        prompt: "Only power 1 remains. Begin the final root merge between A and the already-combined right run.",
        start: [1, 5, 9, 11, 12, 2, 3, 4, 6, 7, 8, 10],
        target: [1, 2, 3, 4, 5, 9, 11, 12, 6, 7, 8, 10],
        decision: {
          power: 1,
          label: "Final root merge",
          detail: "Power 1 sits high in the merge tree, so Powersort waited until the three right-hand runs had become one.",
        },
        hint: "Move 2, then 3, then 4 into the gaps after 1. The groups show the final uneven merge.",
        groups: [
          { range: [0, 4], label: "run A", detail: "left side of the final merge", tone: "cyan", active: true },
          { range: [5, 11], label: "combined B+C+D run", detail: "right side of the final merge", tone: "violet", active: true },
        ],
      },
      {
        prompt: "Finish the same power-1 root merge. The four discovered runs become one ordered row.",
        start: [1, 2, 3, 4, 5, 9, 11, 12, 6, 7, 8, 10],
        target: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        decision: {
          power: 1,
          label: "Final root merge",
          detail: "The priority plan is complete: short local merges happened first and the broad root merge happened last.",
        },
        hint: "Bring 6, 7, 8, and 10 into the remaining gaps. Every move that improves this final merge stays.",
        groups: [
          { range: [0, 4], label: "run A", detail: "left side of the final merge", tone: "cyan", active: true },
          { range: [5, 11], label: "combined B+C+D run", detail: "right side of the final merge", tone: "violet", active: true },
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
    learnTitle: "Let chance do the sorting",
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
        prompt: "Press Gamble to shuffle this four-value row. Keep trying until chance lands on the one sorted order.",
        start: BOGO_PRACTICE_INITIAL_VALUES,
        target: [1, 2, 3, 4],
        hint: "Every click is a fresh, equally likely guess. There is no useful move to preserve.",
      },
    ],
  },
};

// These are deliberately written as complete, runnable Python functions instead
// of pseudo-code. They mirror the decisions used by the visualizer; the React
// implementation additionally records animation frames and work counters.
const PYTHON_IMPLEMENTATIONS: Record<AlgorithmId, string> = {
  bogo: String.raw`import random


def bogo_sort(values, max_attempts=999_999_999):
    values = list(values)
    attempts = 0

    while any(values[index - 1] > values[index] for index in range(1, len(values))):
        if max_attempts is not None and attempts >= max_attempts:
            return values, False

        # Fisher-Yates: every permutation is equally likely.
        for index in range(len(values) - 1, 0, -1):
            swap_index = random.randrange(index + 1)
            if swap_index != index:
                values[index], values[swap_index] = values[swap_index], values[index]

        attempts += 1

    return values, True`,
  selection: String.raw`def selection_sort(values):
    values = list(values)

    for start in range(len(values) - 1):
        minimum = start

        for scan in range(start + 1, len(values)):
            if values[scan] < values[minimum]:
                minimum = scan

        if minimum != start:
            values[start], values[minimum] = values[minimum], values[start]

    return values`,
  insertion: String.raw`def insertion_sort(values):
    values = list(values)

    for index in range(1, len(values)):
        key = values[index]
        insert_at = index - 1

        while insert_at >= 0 and values[insert_at] > key:
            values[insert_at + 1] = values[insert_at]
            insert_at -= 1

        values[insert_at + 1] = key

    return values`,
  bubble: String.raw`def bubble_sort(values):
    values = list(values)

    for upper in range(len(values) - 1, 0, -1):
        swapped = False

        for index in range(upper):
            if values[index] > values[index + 1]:
                values[index], values[index + 1] = values[index + 1], values[index]
                swapped = True

        if not swapped:
            break

    return values`,
  cocktail: String.raw`def cocktail_sort(values):
    values = list(values)
    lower = 0
    upper = len(values) - 1

    while lower < upper:
        swapped = False

        for index in range(lower, upper):
            if values[index] > values[index + 1]:
                values[index], values[index + 1] = values[index + 1], values[index]
                swapped = True

        upper -= 1
        if not swapped or lower >= upper:
            break

        swapped = False
        for index in range(upper, lower - 1, -1):
            if values[index] > values[index + 1]:
                values[index], values[index + 1] = values[index + 1], values[index]
                swapped = True

        lower += 1
        if not swapped:
            break

    return values`,
  heap: String.raw`def heap_sort(values):
    values = list(values)

    def sift_down(root, heap_size):
        while True:
            left = root * 2 + 1
            if left >= heap_size:
                return

            right = left + 1
            largest = right if right < heap_size and values[right] > values[left] else left
            if values[root] >= values[largest]:
                return

            values[root], values[largest] = values[largest], values[root]
            root = largest

    for root in range(len(values) // 2 - 1, -1, -1):
        sift_down(root, len(values))

    for end in range(len(values) - 1, 0, -1):
        values[0], values[end] = values[end], values[0]
        sift_down(0, end)

    return values`,
  quick: String.raw`def quick_sort(values):
    values = list(values)
    stack = [(0, len(values) - 1)] if len(values) > 1 else []

    while stack:
        low, high = stack.pop()
        if low >= high:
            continue

        # Sortscope's Quick Sort parks the rightmost value as the pivot.
        pivot = values[high]
        store = low

        for scan in range(low, high):
            if values[scan] <= pivot:
                values[scan], values[store] = values[store], values[scan]
                store += 1

        values[store], values[high] = values[high], values[store]

        # Push right first so the left partition is handled next.
        if store + 1 < high:
            stack.append((store + 1, high))
        if low < store - 1:
            stack.append((low, store - 1))

    return values`,
  pdq: String.raw`import math


def pdq_sort(values):
    values = list(values)
    insertion_threshold = 16

    def insertion_sort_range(low, high):
        for index in range(low + 1, high + 1):
            key = values[index]
            insert_at = index - 1
            while insert_at >= low and values[insert_at] > key:
                values[insert_at + 1] = values[insert_at]
                insert_at -= 1
            values[insert_at + 1] = key

    def heap_sort_range(low, high):
        length = high - low + 1

        def sift_down(root, heap_size):
            while True:
                left = root * 2 + 1
                if left >= heap_size:
                    return
                right = left + 1
                largest = right if right < heap_size and values[low + right] > values[low + left] else left
                if values[low + root] >= values[low + largest]:
                    return
                values[low + root], values[low + largest] = values[low + largest], values[low + root]
                root = largest

        for root in range(length // 2 - 1, -1, -1):
            sift_down(root, length)
        for end in range(length - 1, 0, -1):
            values[low], values[low + end] = values[low + end], values[low]
            sift_down(0, end)

    def median_of_three_index(low, high):
        middle = low + (high - low) // 2
        if values[low] < values[middle]:
            if values[middle] < values[high]:
                return middle
            return high if values[low] < values[high] else low
        if values[low] < values[high]:
            return low
        return high if values[middle] < values[high] else middle

    def break_patterns(low, high):
        length = high - low + 1
        if length < 8:
            return
        first = low + 1
        middle = low + length // 2
        last = high - 1
        values[first], values[middle] = values[middle], values[first]
        values[middle], values[last] = values[last], values[middle]

    def partition(low, high, pivot):
        left, right = low, high
        did_swap = False

        while True:
            while values[left] < pivot:
                left += 1
            while values[right] > pivot:
                right -= 1
            if left >= right:
                return right, did_swap

            values[left], values[right] = values[right], values[left]
            did_swap = True
            left += 1
            right -= 1

    bad_allowed = max(1, math.floor(math.log2(max(len(values), 2))) * 2)
    stack = [(0, len(values) - 1, bad_allowed)] if len(values) > 1 else []

    while stack:
        low, high, bad_allowed = stack.pop()
        length = high - low + 1

        if length <= insertion_threshold:
            insertion_sort_range(low, high)
            continue

        pivot = values[median_of_three_index(low, high)]
        split, did_swap = partition(low, high, pivot)

        if not did_swap and all(values[index - 1] <= values[index] for index in range(low + 1, high + 1)):
            continue

        left_size = split - low + 1
        right_size = high - split
        child_bad_allowed = bad_allowed

        if min(left_size, right_size) * 8 < length:
            child_bad_allowed -= 1
            if child_bad_allowed <= 0:
                heap_sort_range(low, high)
                continue
            break_patterns(low, split)
            break_patterns(split + 1, high)

        # Schedule the larger side first so the smaller side runs next.
        if left_size > right_size:
            if low < split:
                stack.append((low, split, child_bad_allowed))
            if split + 1 < high:
                stack.append((split + 1, high, child_bad_allowed))
        else:
            if split + 1 < high:
                stack.append((split + 1, high, child_bad_allowed))
            if low < split:
                stack.append((low, split, child_bad_allowed))

    return values`,
  merge: String.raw`def merge_sort(values):
    values = list(values)
    width = 1

    while width < len(values):
        for left in range(0, len(values), width * 2):
            middle = min(left + width, len(values))
            right = min(left + width * 2, len(values))
            if middle >= right:
                continue

            left_run = values[left:middle]
            right_run = values[middle:right]
            left_index = right_index = 0
            destination = left

            while left_index < len(left_run) and right_index < len(right_run):
                if left_run[left_index] <= right_run[right_index]:
                    values[destination] = left_run[left_index]
                    left_index += 1
                else:
                    values[destination] = right_run[right_index]
                    right_index += 1
                destination += 1

            values[destination:right] = left_run[left_index:] + right_run[right_index:]

        width *= 2

    return values`,
  powersort: String.raw`def powersort(values):
    values = list(values)
    size = len(values)
    if size < 2:
        return values

    def discover_natural_run(start):
        end = start + 1

        if end < size:
            if values[start] > values[end]:
                end += 1
                while end < size and values[end - 1] > values[end]:
                    end += 1
                values[start:end] = reversed(values[start:end])
            else:
                end += 1
                while end < size and values[end - 1] <= values[end]:
                    end += 1

        return start, end

    def node_power(left, right):
        denominator = size * 2
        left_centre = left[0] * 2 + (left[1] - left[0])
        right_centre = right[0] * 2 + (right[1] - right[0])
        power = 0

        while left_centre != right_centre and power < 53:
            left_centre *= 2
            right_centre *= 2
            left_bit = left_centre // denominator
            right_bit = right_centre // denominator
            power += 1

            if left_bit != right_bit:
                return power

            left_centre %= denominator
            right_centre %= denominator

        return max(power, 1)

    def merge_runs(left, right):
        left_values = values[left[0]:left[1]]
        right_values = values[right[0]:right[1]]
        left_index = right_index = 0
        destination = left[0]

        while left_index < len(left_values) and right_index < len(right_values):
            if left_values[left_index] <= right_values[right_index]:
                values[destination] = left_values[left_index]
                left_index += 1
            else:
                values[destination] = right_values[right_index]
                right_index += 1
            destination += 1

        values[destination:right[1]] = left_values[left_index:] + right_values[right_index:]
        return left[0], right[1]

    current = discover_natural_run(0)
    next_start = current[1]
    stack = []  # (run, boundary power)

    while next_start < size:
        next_run = discover_natural_run(next_start)
        next_start = next_run[1]
        power = node_power(current, next_run)

        # Close deeper boundaries before this wider one.
        while stack and stack[-1][1] > power:
            previous_run, previous_power = stack.pop()
            current = merge_runs(previous_run, current)

        stack.append((current, power))
        current = next_run

    while stack:
        previous_run, previous_power = stack.pop()
        current = merge_runs(previous_run, current)

    return values`,
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

function arraysMatch(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getPracticeGroupAtIndex(groups: PracticeGroup[], index: number) {
  return groups.find((group) => index >= group.range[0] && index <= group.range[1]);
}

// Every hands-on lesson uses a complete, consecutive set of values. Small
// legacy examples are extended with already-visible trailing values so even a
// first lesson has enough blocks to feel like a real little array. Powersort
// is allowed to use twelve blocks because its uneven natural runs need enough
// room to make its merge order visibly different from Merge Sort.
function normalizePracticeSteps(steps: PracticeStep[]): PracticeStep[] {
  return steps.map((step) => {
    const largestValue = Math.max(...step.start, ...step.target, 1);
    const blockCount = Math.min(12, Math.max(6, largestValue));
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

function formatWorkloadMultiplier(value: number) {
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
    // The implementation keeps the copied key in the working array until the
    // final write, but the visual model lifts it out immediately. That gives
    // the learner a real empty slot to follow as each larger value shifts
    // right, rather than making the key appear to teleport into place.
    let heldKeyGapIndex = i;
    let compactShiftCount = 0;

    steps.push({
      values: [...values],
      pass: i,
      phase: "select",
      key,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: heldKeyGapIndex,
      sortedCount: i,
      comparisons,
      writes,
      message:
        "Pass " + i + ": store " + key + " as the key and open a gap at position " +
        (i + 1) + ".",
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
      compactShiftCount += 1;
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
          message:
            values[j] +
            " shifts right; the open gap moves to position " +
            (heldKeyGapIndex + 1) +
            ".",
        });
      }

      j -= 1;
    }

    // Dense arrays still need to teach the key-and-gap motion. Keep their
    // compact timeline bounded, but retain one post-shift frame before the
    // placement frame so a long pass can never look like a direct teleport.
    if (useCompactFrames && compactShiftCount > 0) {
      steps.push({
        values: [...values],
        pass: i,
        phase: "shift",
        key,
        comparing: null,
        shifting: j + 1,
        inserting: null,
        gapIndex: heldKeyGapIndex,
        sortedCount: i,
        comparisons,
        writes,
        message:
          "Shift " +
          compactShiftCount +
          " larger " +
          (compactShiftCount === 1 ? "value" : "values") +
          " right; the open gap is now at position " +
          (heldKeyGapIndex + 1) +
          ".",
      });
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
      message: "Place stored key " + key + " into the gap at position " + (j + 1) + ".",
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

function detectCanvas2DSupport() {
  if (typeof document === "undefined") return false;
  try {
    return document.createElement("canvas").getContext("2d") !== null;
  } catch {
    return false;
  }
}

function useCanvas2DSupported() {
  // Keep the DOM renderer as a safe fallback for any unusual embedded host
  // that exposes a canvas element without a 2D context. A lazy initial value
  // avoids an extra render solely to probe browser capability.
  const [isSupported] = useState(detectCanvas2DSupport);
  return isSupported;
}

function getBarClass(
  index: number,
  step: SortStep,
  algorithm: AlgorithmId,
  settledIndices: ReadonlySet<number> | null,
) {
  if (algorithm === "bogo") {
    if (step.phase === "complete") return "bar--sorted";
    if (step.phase === "limited") return "bar--limited";
    if (step.phase === "shuffle") return "bar--shuffle";
    return "bar--idle";
  }

  if (algorithm === "quick" || algorithm === "pdq") {
    if (step.phase === "complete") return "bar--sorted";
    // Quick Sort's active pivot must outrank a final-looking or already
    // certified position. That makes a partition's current anchor legible
    // even on a row where the pivot happens to be sitting in sorted order.
    if (algorithm === "quick" && index === step.pivotIndex) return "bar--pivot";
    // A settled pivot is in its final index. Keep that proof visible at every
    // array size while the active pivot and swaps show the current partition.
    if (settledIndices?.has(index)) {
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

    // A merge alternates compare and write snapshots. Keep its whole working
    // range in one quiet blue context across both kinds of snapshot; otherwise
    // every compare frame drops the rest of the range back to idle and the
    // following write frame lights the entire group again. Only the two values
    // being compared or the destination being written should change color.
    const isActiveMergeRange =
      (step.phase === "compare" || step.phase === "merge") &&
      step.rangeStart !== undefined &&
      step.rangeEnd !== undefined &&
      index >= step.rangeStart &&
      index < step.rangeEnd;

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
    if (isActiveMergeRange) {
      return "bar--merge";
    }
    return "bar--idle";
  }

  if (algorithm === "bubble" || algorithm === "cocktail") {
    if (step.phase === "complete" || settledIndices?.has(index)) return "bar--sorted";
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
    if (step.phase === "complete" || settledIndices?.has(index)) return "bar--sorted";
    if (step.phase === "swap" && (index === step.comparing || index === step.shifting)) {
      return "bar--swap";
    }
    if (index === step.comparing || index === step.shifting) return "bar--compare";
    if (index === step.inserting) return "bar--key";
    return "bar--idle";
  }

  if (algorithm === "heap") {
    if (step.phase === "complete" || settledIndices?.has(index)) return "bar--sorted";
    if (step.phase === "heapify") {
      // In a sift-down frame `comparing` is the current parent/root and
      // `shifting` is its chosen child. Keeping those roles distinct matters
      // most on compact rows where there is little contextual space.
      if (index === step.comparing) return "bar--key";
      if (index === step.shifting) return "bar--heap";
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
    // A gap takes the held key's identity so FLIP can animate the same item
    // across right shifts and its final placement. Its rendered height stays
    // empty, however—the key itself is visibly stored in the tray above.
    const identityValue = isGap ? step.key! : value;
    const occurrence = occurrences.get(identityValue) ?? 0;
    occurrences.set(identityValue, occurrence + 1);

    return {
      value: isGap ? 0 : value,
      token: String(identityValue) + ":" + String(occurrence),
      isGap,
    };
  });
}

function haveSameBarTokens(left: RenderedBarItem[], right: RenderedBarItem[]) {
  if (left.length !== right.length) return false;
  const rightTokens = new Set(right.map((item) => item.token));
  return left.every((item) => rightTokens.has(item.token));
}

type SortingBarSlotProps = {
  value: number;
  isGap: boolean;
  height: number;
  barClassName: string;
  showValue: boolean;
  motionToken: string | null;
  slideOffset: number | undefined;
  onMotionBarRef: ((token: string, element: HTMLDivElement | null) => void) | null;
  completionScanDelay: number | undefined;
  completionScanDuration: number | undefined;
};

// Dense rows routinely contain 256 bars while only one or two values change
// in a normal algorithm step. Keep those untouched bar subtrees out of React's
// commit work. This is especially important in WebKit, where reapplying inline
// styles to every narrow bar can cost more than the algorithm itself.
const SortingBarSlot = memo(function SortingBarSlot({
  value,
  isGap,
  height,
  barClassName,
  showValue,
  motionToken,
  slideOffset,
  onMotionBarRef,
  completionScanDelay,
  completionScanDuration,
}: SortingBarSlotProps) {
  const slotStyle =
    slideOffset === undefined
      ? undefined
      : ({ transform: "translateX(" + slideOffset + "px)" } as CSSProperties);
  const completionScanActive =
    completionScanDelay !== undefined && completionScanDuration !== undefined;
  const barStyle = completionScanActive
    ? ({
        height: String(height) + "%",
        "--completion-scan-delay": String(completionScanDelay) + "ms",
        "--completion-scan-duration": String(completionScanDuration) + "ms",
      } as CSSProperties)
    : { height: String(height) + "%" };

  return (
    <div
      className="bar-slot"
      ref={
        motionToken !== null && onMotionBarRef !== null
          ? (element) => onMotionBarRef(motionToken, element)
          : undefined
      }
      style={slotStyle}
    >
      <div
        className={"bar " + barClassName + (completionScanActive ? " bar--completion-scan" : "")}
        style={barStyle}
      >
        {showValue && <span className="bar__value">{isGap ? "gap" : value}</span>}
      </div>
    </div>
  );
});

type DenseBarCanvasFrame = {
  items: RenderedBarItem[];
  largestValue: number;
  step: SortStep;
  algorithm: AlgorithmId;
  settledIndices: ReadonlySet<number> | null;
  completionSweepActive: boolean;
  completionSweepStepDuration: number;
  prefersReducedMotion: boolean;
};

type DensePlaybackTiming = {
  stepDelay: number;
  stepStride: number;
};

type DenseCanvasReadout = {
  trace: SortStep[];
  step: SortStep;
  stepIndex: number;
};

type DenseBarCanvasPlayback = {
  steps: SortStep[];
  initialStepIndex: number;
  isRunning: boolean;
  getPlaybackTiming: (step: SortStep) => DensePlaybackTiming;
  onPlaybackIndex: (stepIndex: number) => void;
  onVisualStep: (step: SortStep, stepIndex: number) => void;
  onAudioStep?: (step: SortStep) => void;
  onCheckpoint: (stepIndex: number, isComplete: boolean) => void;
  onContextUnavailable: () => void;
};

type DenseBarCanvasProps = DenseBarCanvasFrame & DenseBarCanvasPlayback;

type DenseCanvasSurface = {
  width: number;
  height: number;
  pixelRatio: number;
};

const DENSE_CANVAS_BAR_COLORS: Record<string, string> = {
  "bar--idle": "#3d477c",
  "bar--sorted": "#68d595",
  "bar--limited": "#d76975",
  "bar--shuffle": "#ba72e6",
  "bar--key": "#9586f6",
  "bar--pivot": "#ef9848",
  "bar--compare": "#f4c35d",
  "bar--shift": "#ed8977",
  "bar--insert": "#9784f5",
  "bar--swap": "#ed8977",
  "bar--merge": "#5784ac",
  "bar--run": "#65c9b7",
  "bar--power": "#a77be0",
  "bar--heap": "#739de4",
};

function getDenseCanvasBarColor(barClassName: string, isCompletionScan: boolean) {
  if (isCompletionScan) return "#f0445b";
  return DENSE_CANVAS_BAR_COLORS[barClassName] ?? DENSE_CANVAS_BAR_COLORS["bar--idle"];
}

// A max-size row can update dozens of times a second. Its prior implementation
// made React reconcile 256 flex children and asked WebKit to repaint a gradient
// and border for each one. Canvas keeps the same colors and status emphasis in
// a single low-overhead surface. It intentionally only serves the fast dense
// mode: the DOM path remains responsible for slow FLIP movement and labels.
const DenseBarCanvas = memo(function DenseBarCanvas({
  items,
  largestValue,
  step,
  algorithm,
  settledIndices,
  completionSweepActive,
  completionSweepStepDuration,
  prefersReducedMotion,
  steps,
  initialStepIndex,
  isRunning,
  getPlaybackTiming,
  onPlaybackIndex,
  onVisualStep,
  onAudioStep,
  onCheckpoint,
  onContextUnavailable,
}: DenseBarCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const surfaceRef = useRef<DenseCanvasSurface>({ width: 0, height: 0, pixelRatio: 1 });
  const frameRef = useRef<DenseBarCanvasFrame>({
    items,
    largestValue,
    step,
    algorithm,
    settledIndices,
    completionSweepActive,
    completionSweepStepDuration,
    prefersReducedMotion,
  });
  const drawRef = useRef<(now?: number) => void>(() => undefined);
  const completionStartedAtRef = useRef<number | null>(null);
  const playbackTraceRef = useRef<SortStep[] | null>(null);
  const contextUnavailableReportedRef = useRef(false);
  const latestStepsRef = useRef(steps);
  const playbackStepIndexRef = useRef(initialStepIndex);
  const playbackConfigRef = useRef({
    initialStepIndex,
    getPlaybackTiming,
    onPlaybackIndex,
    onVisualStep,
    onAudioStep,
    onCheckpoint,
  });
  // Insertion effects run before layout-effect teardown. That lets the old
  // local runner recognize a new trace before its cleanup can flush a stale
  // index into a freshly reset run.
  useInsertionEffect(() => {
    latestStepsRef.current = steps;
  }, [steps]);

  const draw = useCallback((now = performance.now()) => {
    const canvas = canvasRef.current;
    const { width, height, pixelRatio } = surfaceRef.current;
    if (!canvas || width <= 0 || height <= 0) return;

    const context = contextRef.current;
    if (!context) return;

    const frame = frameRef.current;
    const itemCount = frame.items.length;
    if (itemCount === 0) return;

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;

    const completionStartedAt = completionStartedAtRef.current;
    const completionElapsed =
      completionStartedAt === null
        ? -1
        : now - completionStartedAt - COMPLETION_SWEEP_AUDIO_VISUAL_LEAD;
    const completionIndex =
      frame.completionSweepActive &&
      !frame.prefersReducedMotion &&
      completionElapsed >= 0 &&
      frame.completionSweepStepDuration > 0
        ? Math.min(
            itemCount - 1,
            Math.floor(completionElapsed / frame.completionSweepStepDuration),
          )
        : -1;

    // Keep the original one-pixel dense gap when there is enough room. At
    // narrower layouts a fractional gap costs more visual clarity than it
    // gives, so the bars share the surface cleanly instead.
    const gap = itemCount > 1 && width / itemCount >= 3 ? 1 : 0;
    const barWidth = Math.max(1, (width - gap * (itemCount - 1)) / itemCount);
    const maximum = Math.max(frame.largestValue, 1);

    for (let index = 0; index < itemCount; index += 1) {
      const item = frame.items[index]!;
      const x = index * (barWidth + gap);

      if (item.isGap) {
        const gapHeight = Math.max(16, height * 0.1);
        context.save();
        context.strokeStyle = "rgba(183, 174, 255, 0.86)";
        context.lineWidth = 1;
        context.setLineDash([2, 2]);
        context.strokeRect(x + 0.5, height - gapHeight + 0.5, Math.max(0, barWidth - 1), gapHeight);
        context.restore();
        continue;
      }

      const barHeight = Math.max(0, Math.min(height, (item.value / maximum) * height));
      const barClassName = getBarClass(index, frame.step, frame.algorithm, frame.settledIndices);
      context.fillStyle = getDenseCanvasBarColor(barClassName, index === completionIndex);
      context.fillRect(x, height - barHeight, barWidth, barHeight);
    }
  }, []);

  useLayoutEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  useLayoutEffect(() => {
    playbackConfigRef.current = {
      initialStepIndex,
      getPlaybackTiming,
      onPlaybackIndex,
      onVisualStep,
      onAudioStep,
      onCheckpoint,
    };
  }, [
    initialStepIndex,
    getPlaybackTiming,
    onAudioStep,
    onCheckpoint,
    onPlaybackIndex,
    onVisualStep,
  ]);

  const drawPlaybackStep = useCallback((
    nextStep: SortStep,
    nextStepIndex: number,
    isAdvance = false,
  ) => {
    const settled = nextStep.settled ?? [];
    const visuallySettled = nextStep.visualSettled ?? [];
    frameRef.current = {
      items: getRenderedBarItems(nextStep),
      largestValue,
      step: nextStep,
      algorithm,
      settledIndices:
        settled.length === 0 && visuallySettled.length === 0
          ? null
          : new Set([...settled, ...visuallySettled]),
      // A live dense run cannot be in its completion sweep yet. Preserve the
      // current props nevertheless so the ordinary React sync owns the final
      // red scan once the terminal checkpoint commits.
      completionSweepActive: frameRef.current.completionSweepActive,
      completionSweepStepDuration: frameRef.current.completionSweepStepDuration,
      prefersReducedMotion: frameRef.current.prefersReducedMotion,
    };
    drawRef.current();
    playbackConfigRef.current.onPlaybackIndex(nextStepIndex);
    if (isAdvance) {
      const config = playbackConfigRef.current;
      config.onVisualStep(nextStep, nextStepIndex);
      config.onAudioStep?.(nextStep);
    }
  }, [algorithm, largestValue]);

  useLayoutEffect(() => {
    const localPlaybackStep = steps[playbackStepIndexRef.current];
    // Pausing changes the parent state before its checkpoint callback has
    // committed. Keep the last canvas frame in place during that tiny handoff
    // instead of drawing the previous semantic snapshot for one frame.
    const isAwaitingPlaybackFlush =
      !isRunning &&
      playbackTraceRef.current === steps &&
      localPlaybackStep !== undefined &&
      step !== localPlaybackStep;
    if ((isRunning && steps.length > 0) || isAwaitingPlaybackFlush) return;
    frameRef.current = {
      items,
      largestValue,
      step,
      algorithm,
      settledIndices,
      completionSweepActive,
      completionSweepStepDuration,
      prefersReducedMotion,
    };
    draw();
  }, [
    algorithm,
    completionSweepActive,
    completionSweepStepDuration,
    draw,
    items,
    largestValue,
    prefersReducedMotion,
    settledIndices,
    step,
    isRunning,
    steps,
  ]);

  useLayoutEffect(() => {
    if (!isRunning || steps.length === 0) return;

    const finalStepIndex = steps.length - 1;
    if (playbackTraceRef.current !== steps) {
      playbackTraceRef.current = steps;
      const { initialStepIndex: nextInitialStepIndex } = playbackConfigRef.current;
      playbackStepIndexRef.current = Math.min(
        finalStepIndex,
        Math.max(0, nextInitialStepIndex),
      );
    }

    let animationFrame = 0;
    let lastAdvanceAt = performance.now();
    const currentStepIndex = () => playbackStepIndexRef.current;

    drawPlaybackStep(steps[currentStepIndex()]!, currentStepIndex());

    const advance = (now: number) => {
      const {
        getPlaybackTiming: latestPlaybackTiming,
        onCheckpoint: latestCheckpoint,
      } = playbackConfigRef.current;
      let elapsed = now - lastAdvanceAt;
      let nextStepIndex = currentStepIndex();

      // Merge Sort deliberately gives each pass a shared visual duration.
      // The local canvas runner cannot rely on React's stale `currentStep`,
      // so consume timing one visible step at a time and re-read the pass
      // policy whenever its local index crosses into a new merge pass.
      while (nextStepIndex < finalStepIndex) {
        const timing = latestPlaybackTiming(steps[nextStepIndex]!);
        const nextDelay = Math.max(1, timing.stepDelay);
        if (elapsed < nextDelay) break;

        elapsed -= nextDelay;
        lastAdvanceAt += nextDelay;
        nextStepIndex = Math.min(
          finalStepIndex,
          nextStepIndex + Math.max(1, timing.stepStride),
        );
      }

      if (nextStepIndex !== currentStepIndex()) {
        playbackStepIndexRef.current = nextStepIndex;
        drawPlaybackStep(steps[nextStepIndex]!, nextStepIndex, true);

        if (nextStepIndex === finalStepIndex) {
          latestCheckpoint(nextStepIndex, true);
          return;
        }
      }

      animationFrame = window.requestAnimationFrame(advance);
    };

    animationFrame = window.requestAnimationFrame(advance);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      // A pause or a switch back to the DOM renderer must resume at the
      // exact canvas frame just painted, not the last 50 ms React checkpoint.
      // On reset/new traces the render-time trace ref already points to the
      // new list, so stale cleanup cannot overwrite the fresh index zero
      // state before the next paint.
      if (latestStepsRef.current === steps) {
        playbackConfigRef.current.onCheckpoint(playbackStepIndexRef.current, false);
      }
    };
  }, [
    drawPlaybackStep,
    isRunning,
    steps,
  ]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext("2d");
    } catch {
      // Some embedded WebViews expose a canvas element but reject 2D context
      // acquisition after the initial feature probe. Let the parent choose
      // the established DOM renderer rather than leaving an empty chart.
    }
    if (!context) {
      contextRef.current = null;
      if (!contextUnavailableReportedRef.current) {
        contextUnavailableReportedRef.current = true;
        onContextUnavailable();
      }
      return;
    }
    contextRef.current = context;

    const resizeSurface = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const pixelRatio = Math.min(window.devicePixelRatio || 1, DENSE_CANVAS_MAX_PIXEL_RATIO);
      const backingWidth = Math.max(1, Math.round(width * pixelRatio));
      const backingHeight = Math.max(1, Math.round(height * pixelRatio));

      surfaceRef.current = { width, height, pixelRatio };
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      drawRef.current();
    };

    resizeSurface();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", resizeSurface);
      return () => {
        window.removeEventListener("resize", resizeSurface);
        contextRef.current = null;
      };
    }

    const observer = new ResizeObserver(resizeSurface);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      contextRef.current = null;
    };
  }, [onContextUnavailable]);

  useEffect(() => {
    if (!completionSweepActive || prefersReducedMotion) {
      completionStartedAtRef.current = null;
      return;
    }

    completionStartedAtRef.current = performance.now();
    const animationEnd =
      COMPLETION_SWEEP_AUDIO_VISUAL_LEAD + completionSweepStepDuration * Math.max(items.length, 1);
    let animationFrame = 0;
    const animate = (now: number) => {
      drawRef.current(now);
      if (now - completionStartedAtRef.current! < animationEnd) {
        animationFrame = window.requestAnimationFrame(animate);
      }
    };
    animationFrame = window.requestAnimationFrame(animate);

    return () => window.cancelAnimationFrame(animationFrame);
  }, [completionSweepActive, completionSweepStepDuration, items.length, prefersReducedMotion]);

  return <canvas className="bars-canvas" ref={canvasRef} aria-hidden="true" />;
});

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
  const [introPhase, setIntroPhase] = useState<IntroPhase>(getInitialIntroPhase);
  const [algorithm, setAlgorithm] = useState<AlgorithmId>("bogo");
  const [isAlgorithmPickerOpen, setIsAlgorithmPickerOpen] = useState(false);
  const [algorithmCardTab, setAlgorithmCardTab] = useState<AlgorithmCardTab>("walkthrough");
  const [arraySize, setArraySize] = useState(INITIAL_ARRAY_SIZE);
  const [arraySizeInput, setArraySizeInput] = useState(String(INITIAL_ARRAY_SIZE));
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
  const [bogoUnlimitedConfirmationOpen, setBogoUnlimitedConfirmationOpen] = useState(false);
  const [arrayArrangement, setArrayArrangement] = useState<ArrayArrangement>("random");
  const [benchmarkPattern, setBenchmarkPattern] =
    useState<BenchmarkPattern>("random");
  const [benchmarkTab, setBenchmarkTab] = useState<BenchmarkTab>("table");
  const [visibleWorkloadBarAlgorithms, setVisibleWorkloadBarAlgorithms] = useState(
    () => ({ ...DEFAULT_WORKLOAD_BAR_ALGORITHM_VISIBILITY }),
  );
  // Keep a deselected bar mounted just long enough to play its exit motion.
  // The number is a per-action generation, so a quick off/on/off sequence
  // can never let an older animation remove the newest row.
  const [exitingWorkloadBarAlgorithms, setExitingWorkloadBarAlgorithms] =
    useState<WorkloadBarTransitionMap>({});
  const [enteringWorkloadBarAlgorithms, setEnteringWorkloadBarAlgorithms] =
    useState<WorkloadBarTransitionMap>({});
  const [workloadBarSize, setWorkloadBarSize] = useState(65_536);
  const [originalValues, setOriginalValues] = useState(INITIAL_VALUES);
  const [values, setValues] = useState(INITIAL_VALUES);
  const [steps, setSteps] = useState<SortStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [runState, setRunState] = useState<RunState>("ready");
  // Feature detection succeeds in a few desktop WebViews that still decline
  // a real 2D context at mount. Treat that as a session-level capability miss
  // and stay on the proven DOM renderer rather than repeatedly mounting a
  // blank canvas.
  const [canvasRendererUnavailable, setCanvasRendererUnavailable] = useState(false);
  const [bogoLiveStep, setBogoLiveStep] = useState<SortStep | null>(null);
  const [bogoMeasuredShuffleRate, setBogoMeasuredShuffleRate] = useState<number | null>(null);
  const [bogoFrozenExpectedShuffleRate, setBogoFrozenExpectedShuffleRate] = useState<number | null>(null);
  const [bogoExpectedRateSource, setBogoExpectedRateSource] = useState<
    "calibrating" | "measured" | "modeled"
  >("calibrating");
  // A module Worker is the normal fast-run path. Keep the established
  // main-thread scheduler as a compatibility fallback for older webviews or
  // desktop policies that reject worker assets.
  const [bogoWorkerUnavailable, setBogoWorkerUnavailable] = useState(false);
  const [bogoElapsedMilliseconds, setBogoElapsedMilliseconds] = useState(0);
  const [bogoCelebrationPhase, setBogoCelebrationPhase] = useState<
    "hidden" | "visible" | "fading"
  >("hidden");
  const [practiceCelebrationPhase, setPracticeCelebrationPhase] = useState<
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
  const [insertionKeyHeld, setInsertionKeyHeld] = useState(true);
  const [insertionKeySelected, setInsertionKeySelected] = useState(false);
  const [practiceSolved, setPracticeSolved] = useState(false);
  const [bogoPracticeEntered, setBogoPracticeEntered] = useState(false);
  const [bogoPracticeBusy, setBogoPracticeBusy] = useState(false);
  const [bogoPracticeRolling, setBogoPracticeRolling] = useState(false);
  const [bogoPracticeAttempts, setBogoPracticeAttempts] = useState(0);
  const [practiceFeedback, setPracticeFeedback] = useState<string | null>(null);
  const [practiceUndoPending, setPracticeUndoPending] = useState(false);
  const introOverlayRef = useRef<HTMLDivElement | null>(null);
  const introDismissTimerRef = useRef<number | null>(null);
  // Keep the modal transition state synchronous with pointer events. React
  // state intentionally paints the phase, while this ref prevents a second
  // click during the fade from leaking through to the page underneath.
  const introPhaseRef = useRef<IntroPhase>(introPhase);
  const introReturnFocusRef = useRef<HTMLElement | null>(null);
  const brandButtonRef = useRef<HTMLButtonElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGestureActivatorRef = useRef<(() => void) | null>(null);
  const speedRef = useRef(speed);
  // Native range controls own their drag behavior. Keep only the pointer ID
  // here so every end path can release our visual-adjustment state without
  // taking pointer capture away from WebKit's slider implementation.
  const speedRangePointerIdRef = useRef<number | null>(null);
  // Keyboard range adjustments do not have a pointer ID, and macOS can drop
  // the final key-up when a WebView loses focus. Track them separately so a
  // held arrow cannot leave the renderer policy frozen after focus changes.
  const speedAdjustmentKeysRef = useRef(new Set<string>());
  const soundVolumeRef = useRef(soundVolume);
  const lastToneTimeRef = useRef(0);
  const lastBogoTextureTimeRef = useRef(0);
  const completionSweepStartedRef = useRef(false);
  const completionSweepStartTimerRef = useRef<number | null>(null);
  const completionSweepEndTimerRef = useRef<number | null>(null);
  const completionSweepRunRef = useRef(0);
  const completionSweepAudioRunRef = useRef<CompletionSweepAudioRun | null>(null);
  const liveToneSourcesRef = useRef(new Set<OscillatorNode>());
  const liveToneOutputRef = useRef<GainNode | null>(null);
  const denseLiveToneVoiceRef = useRef<DenseLiveToneVoice | null>(null);
  const motionBarElementsRef = useRef(new Map<string, HTMLDivElement>());
  const motionBarPositionsRef = useRef(new Map<string, number>());
  const motionBarTokensRef = useRef<string[]>([]);
  const motionBarInterpolationEnabledRef = useRef(false);
  // A range drag keeps the renderer mode frozen at its pre-drag threshold.
  // Remember that the FLIP work has been paused so individual playback steps
  // do not repeatedly clear/cancel animation state while the thumb is held.
  const motionBarInterpolationPausedRef = useRef(false);
  const setMotionBarRef = useCallback((token: string, element: HTMLDivElement | null) => {
    if (element) {
      motionBarElementsRef.current.set(token, element);
      return;
    }
    motionBarElementsRef.current.delete(token);
  }, []);
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
  const insertionKeyPointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    anchorX: number;
    anchorY: number;
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
  const practiceCelebrationFadeTimerRef = useRef<number | null>(null);
  const practiceCelebrationUnmountTimerRef = useRef<number | null>(null);
  const algorithmPickerRef = useRef<HTMLDivElement | null>(null);
  const algorithmPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const algorithmPickerItemRefs = useRef(new Map<AlgorithmId, HTMLButtonElement>());
  const bogoPracticeAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const bogoPracticeAudioGainRef = useRef<GainNode | null>(null);
  const bogoPracticeAudioClipLoadsRef = useRef(
    new Map<BogoPracticeCasinoSound, Promise<DecodedPcmWav>>(),
  );
  const bogoPracticeAudioTimerRef = useRef<number | null>(null);
  const bogoPracticeAudioRunRef = useRef(0);
  // A casino action can contain several cues (shuffle, then fail/success).
  // Keeping its own generation separate from the individual media element
  // makes a fresh Gamble cancel every stale cue and callback as one unit.
  const bogoPracticeCasinoActionRef = useRef(0);
  const bogoPracticeRollIntervalRef = useRef<number | null>(null);
  const bogoPracticeRollRunRef = useRef(0);
  const workloadBarTransitionRunRef = useRef(0);
  // Completion can be reached by a final scripted move or the global sorted
  // row check. This guard makes those paths share one celebration and one
  // victory tone instead of occasionally firing twice in the same gesture.
  const practiceCompletionRef = useRef(false);
  const practiceCelebrationRunRef = useRef(0);
  const bogoSessionRef = useRef<BogoSession | null>(null);
  const bogoWorkerRef = useRef<Worker | null>(null);
  const bogoWorkerRunIdRef = useRef(0);
  const bogoWorkerConfigurationIdRef = useRef(0);
  const activeBogoWorkerRunRef = useRef<ActiveBogoWorkerRun | null>(null);
  const bogoWorkerStartupTimerRef = useRef<number | null>(null);
  const pendingBogoWorkerRateCalibrationRef =
    useRef<PendingBogoWorkerRateCalibration | null>(null);
  // Dense canvas playback advances imperatively so the 7k-line teaching page
  // is not reconciled at display-frame cadence. These small status nodes stay
  // truthful between semantic React commits (pause, renderer handoff, finish).
  const denseWorkbenchMessageRef = useRef<HTMLParagraphElement | null>(null);
  const densePhaseChipRef = useRef<HTMLDivElement | null>(null);
  const denseHeldKeyRef = useRef<HTMLDivElement | null>(null);
  const denseHeldKeyValueRef = useRef<HTMLElement | null>(null);
  const denseHeldKeyDetailRef = useRef<HTMLElement | null>(null);
  const denseStagePassRef = useRef<HTMLElement | null>(null);
  const denseComparisonCountRef = useRef<HTMLElement | null>(null);
  const denseWriteCountRef = useRef<HTMLElement | null>(null);
  const denseProgressValueRef = useRef<HTMLElement | null>(null);
  const denseProgressFillRef = useRef<HTMLElement | null>(null);
  const denseCanvasPlaybackStepIndexRef = useRef(0);
  const denseCanvasPlaybackTraceRef = useRef<SortStep[] | null>(null);
  const denseCanvasReadoutRef = useRef<DenseCanvasReadout | null>(null);
  const bogoUnlimitedConfirmationRef = useRef(false);
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
  const supportsCanvas2D = useCanvas2DSupported();
  const isBogo = algorithm === "bogo";
  const playbackSpeed = isBogo ? speed : getPlaybackSpeed(speed);
  const smallArrayPianoToneMap = useMemo(
    () => createSmallArrayPianoToneMap(originalValues),
    [originalValues],
  );
  // While a control is being adjusted, keep the visual interpolation policy
  // at the last settled speed. Playback timing continues to use `speed`, so
  // the sort still reacts live without remounting bars at the 50% boundary.
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
  const algorithmOrderIndex = Math.max(0, ALGORITHM_ORDER.indexOf(algorithm));
  const previousAlgorithm =
    ALGORITHM_ORDER[
      (algorithmOrderIndex - 1 + ALGORITHM_ORDER.length) % ALGORITHM_ORDER.length
    ] ?? algorithm;
  const nextAlgorithm =
    ALGORITHM_ORDER[(algorithmOrderIndex + 1) % ALGORITHM_ORDER.length] ?? algorithm;
  const algorithmPickerOptions = ALGORITHM_ORDER.filter(
    (candidate) => candidate !== algorithm,
  );
  const practiceSteps = useMemo(
    () => normalizePracticeSteps(algorithmDetails.practice),
    [algorithmDetails.practice],
  );
  const isBogoPractice = algorithm === "bogo";
  const practiceFinished = practiceStepIndex >= practiceSteps.length;
  const currentPractice = practiceSteps[Math.min(practiceStepIndex, practiceSteps.length - 1)];
  const isQuickPractice = algorithm === "quick" && currentPractice.pivot !== undefined;
  const isPdqPractice = algorithm === "pdq" && currentPractice.pivot !== undefined;
  const isPartitionPractice = isQuickPractice || isPdqPractice;
  const partitionPivot = isPartitionPractice ? currentPractice.pivot ?? null : null;
  const partitionActiveRange = isPartitionPractice ? currentPractice.activeRange : undefined;
  const partitionSettledValues = isPartitionPractice ? currentPractice.settled ?? [] : [];
  const partitionSampleValues = isPdqPractice ? currentPractice.sampleValues ?? [] : [];
  const isInsertionPractice =
    algorithm === "insertion" && currentPractice.insertingKey !== undefined;
  const insertionKey = isInsertionPractice ? currentPractice.insertingKey ?? null : null;
  const preparedInsertionKeyDrop =
    isInsertionPractice && !practiceFinished && insertionKeyHeld && insertionKey !== null
      ? prepareInsertionKeyDrop(practiceValues, insertionKey, currentPractice.target)
      : null;
  const isPreparedInsertionPractice = preparedInsertionKeyDrop !== null;
  // Merge-family lessons use these position-based ranges to make the already
  // ordered runs visually explicit without changing the board's drag geometry.
  const practiceGroups = practiceFinished ? [] : currentPractice.groups ?? [];
  const activePracticeRunBoundarySlots = useMemo(() => {
    if ((algorithm !== "powersort" && algorithm !== "merge") || practiceFinished) {
      return new Set<number>();
    }

    // Neighboring active runs become one merge workspace. Keep its blue
    // brackets at the outer edges so their shared slot never looks like a
    // divider, while separate active workspaces still get their own pair.
    const mergedActiveRanges = practiceGroups
      .filter((group) => group.active)
      .map((group) => group.range)
      .sort(([leftStart], [rightStart]) => leftStart - rightStart)
      .reduce<Array<[number, number]>>((ranges, [start, end]) => {
        const previousRange = ranges.at(-1);
        if (previousRange && start <= previousRange[1] + 1) {
          previousRange[1] = Math.max(previousRange[1], end);
        } else {
          ranges.push([start, end]);
        }
        return ranges;
      }, []);

    return new Set(
      mergedActiveRanges.flatMap(([start, end]) => [start, end + 1]),
    );
  }, [algorithm, practiceFinished, practiceGroups]);
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
  const workloadBarEntry = useMemo(
    () =>
      theoreticalBenchmarkData.find((entry) => entry.size === workloadBarSize) ??
      theoreticalBenchmarkData[0],
    [theoreticalBenchmarkData, workloadBarSize],
  );
  const workloadBarRows = useMemo(
    () =>
      BENCHMARK_ALGORITHMS
        .filter((benchmarkAlgorithm) => visibleWorkloadBarAlgorithms[benchmarkAlgorithm.key])
        .map((benchmarkAlgorithm) => ({
          ...benchmarkAlgorithm,
          color: BENCHMARK_COLORS[benchmarkAlgorithm.key],
          work: workloadBarEntry?.work[benchmarkAlgorithm.key] ?? 0,
        }))
        .sort((left, right) => right.work - left.work),
    [visibleWorkloadBarAlgorithms, workloadBarEntry],
  );
  const renderedWorkloadBarRows = useMemo(
    () =>
      BENCHMARK_ALGORITHMS
        .filter(
          (benchmarkAlgorithm) =>
            visibleWorkloadBarAlgorithms[benchmarkAlgorithm.key] ||
            exitingWorkloadBarAlgorithms[benchmarkAlgorithm.key] !== undefined,
        )
        .map((benchmarkAlgorithm) => ({
          ...benchmarkAlgorithm,
          color: BENCHMARK_COLORS[benchmarkAlgorithm.key],
          work: workloadBarEntry?.work[benchmarkAlgorithm.key] ?? 0,
          exitTransitionId: exitingWorkloadBarAlgorithms[benchmarkAlgorithm.key],
          enterTransitionId: enteringWorkloadBarAlgorithms[benchmarkAlgorithm.key],
        }))
        .sort((left, right) => right.work - left.work),
    [
      enteringWorkloadBarAlgorithms,
      exitingWorkloadBarAlgorithms,
      visibleWorkloadBarAlgorithms,
      workloadBarEntry,
    ],
  );
  const workloadBarMaximum = Math.max(
    1,
    ...renderedWorkloadBarRows.map((row) => row.work),
  );
  const workloadBarFastest = Math.max(
    1,
    ...(workloadBarRows.length ? workloadBarRows : renderedWorkloadBarRows).map(
      (row) => row.work,
    ),
  );

  const currentStep = useMemo(
    () =>
      isBogo && bogoLiveStep
        ? bogoLiveStep
        : steps[stepIndex] ?? createInitialStep(values, algorithm),
    [algorithm, bogoLiveStep, isBogo, stepIndex, steps, values],
  );
  const settledBarIndices = useMemo(() => {
    const settled = currentStep.settled ?? [];
    const visuallySettled = currentStep.visualSettled ?? [];
    if (settled.length === 0 && visuallySettled.length === 0) return null;
    return new Set([...settled, ...visuallySettled]);
  }, [currentStep.settled, currentStep.visualSettled]);
  const renderedBarItems = getRenderedBarItems(currentStep);
  const completionSweepDuration = getCompletionSweepDuration(renderedBarItems.length);
  const completionSweepStepDuration = completionSweepDuration / Math.max(renderedBarItems.length, 1);
  const motionSlideDuration = Math.round(Math.max(170, 880 - interpolationSpeed * 9.4));
  const shouldInterpolateMoves =
    !isBogo &&
    !prefersReducedMotion &&
    interpolationSpeed <= MOVE_INTERPOLATION_MAX_SPEED;
  const previousVisualStep =
    shouldInterpolateMoves && stepIndex > 0 ? steps[stepIndex - 1] : null;
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
  const isSafeVisualMove =
    shouldInterpolateMoves &&
    previousVisualStep !== null &&
    haveSameBarTokens(previousRenderedBarItems, renderedBarItems) &&
    previousRenderedBarItems.some((item, index) => item.token !== renderedBarItems[index]?.token);

  // Keep the page beneath the fixed welcome screen stationary. This guarantees
  // that re-entering through the logo and then dismissing the overlay returns
  // to the actual page top rather than a background scroll position changed by
  // a wheel or touch gesture while the screen was open.
  useLayoutEffect(() => {
    if (introPhase === "hidden") return;

    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
    };
  }, [introPhase]);

  useEffect(() => {
    if (introPhase !== "visible") return;

    const frame = window.requestAnimationFrame(() => introOverlayRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [introPhase]);

  // A modal should not leave keyboard focus on its removed container. The
  // header mark is both the opener and a dependable return point after the
  // first welcome screen.
  useEffect(() => {
    if (introPhase !== "hidden") return;

    const returnTarget = introReturnFocusRef.current;
    introReturnFocusRef.current = null;
    if (!returnTarget) return;

    const frame = window.requestAnimationFrame(() => {
      if (returnTarget.isConnected) returnTarget.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [introPhase]);

  // Prime Web Audio during the first genuine interaction instead of waiting
  // for a later timer or render effect. That distinction matters in macOS
  // WKWebView, which can otherwise leave an AudioContext suspended even
  // though the sorting action itself was clicked. Capture phase makes this
  // run before React's click handlers and covers both mouse/touch and keys.
  useEffect(() => {
    const activateFromGesture = () => {
      if (soundVolumeRef.current <= 0) return;
      try {
        audioGestureActivatorRef.current?.();
      } catch {
        // Controls retain their visual behavior if a host has no audio output.
      }
    };

    window.addEventListener("pointerdown", activateFromGesture, true);
    window.addEventListener("keydown", activateFromGesture, true);
    return () => {
      window.removeEventListener("pointerdown", activateFromGesture, true);
      window.removeEventListener("keydown", activateFromGesture, true);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (introDismissTimerRef.current !== null) {
        window.clearTimeout(introDismissTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isBogo || runState !== "complete" || currentStep.phase !== "complete") {
      return;
    }

    if (soundEnabled) playBogoVictorySound();
    const showTimer = window.setTimeout(() => setBogoCelebrationPhase("visible"), 0);
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
      window.clearTimeout(showTimer);
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

    const resetMotionInterpolation = () => {
      motionBarInterpolationEnabledRef.current = false;
      motionBarPositionsRef.current.clear();
      motionBarTokensRef.current = [];
      // This layout effect must synchronously clear the FLIP paint when its
      // interpolation policy changes; deferring it produces a stale frame.
      setMotionSlideOffsets((current) => (Object.keys(current).length === 0 ? current : {}));
      setMotionSlideStage((stage) => (stage === "idle" ? stage : "idle"));
    };

    // The slider deliberately freezes the renderer policy until release, but
    // it must not keep doing FLIP geometry or animation teardown at every
    // logical step while the live speed value crosses its threshold. Clear
    // any in-flight transform once, retain the same DOM renderer, and let the
    // first settled low-speed frame establish a new baseline after release.
    if (isAdjustingSpeedControl) {
      if (!motionBarInterpolationPausedRef.current) {
        motionBarInterpolationPausedRef.current = true;
        resetMotionInterpolation();
      }
      return;
    }

    motionBarInterpolationPausedRef.current = false;
    if (!shouldInterpolateMoves) {
      // Geometry is only needed for the optional low-speed FLIP animation.
      // Calling getBoundingClientRect for every bar here forces a layout pass
      // on each Bogo snapshot and dense high-speed frame, even though no
      // interpolation can be painted. Reset the cache instead; the first
      // eligible slow-motion frame below establishes a fresh baseline.
      resetMotionInterpolation();
      return;
    }

    const nextTokens = renderedBarItems.map((item) => item.token);
    const nextPositions = captureMotionBarPositions();
    const previousTokens = motionBarTokensRef.current;
    const hasSameTokens =
      previousTokens.length === nextTokens.length &&
      previousTokens.every((token) => nextTokens.includes(token));

    // Do not interpolate from stale geometry after the user enters the
    // low-speed range. This one baseline capture replaces thousands of
    // unnecessary high-speed layout reads while keeping later FLIP moves
    // exactly as before.
    const wasInterpolating = motionBarInterpolationEnabledRef.current;
    motionBarInterpolationEnabledRef.current = true;
    if (!wasInterpolating || !isSafeVisualMove || !hasSameTokens) {
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
  }, [
    currentStep,
    isAdjustingSpeedControl,
    isSafeVisualMove,
    motionSlideDuration,
    shouldInterpolateMoves,
  ]);

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
  // Bogo's runner is intentionally CPU-bound while it is searching. Treat
  // every Bogo configuration input as unavailable for the lifetime of an
  // active session, including the small window before React has rendered the
  // new `running` state. That keeps a stray number/checkbox event from
  // reconfiguring a session that is already executing.
  const hasActiveBogoSession =
    isBogo && bogoSessionRef.current !== null && !bogoSessionRef.current.done;
  const isBogoSessionLocked = isBogo && (isLocked || hasActiveBogoSession);
  const isBogoConfigurationLocked =
    isBogoSessionLocked || bogoUnlimitedConfirmationOpen;

  useEffect(() => {
    if (!isAlgorithmPickerOpen) return;

    const closeWhenFocusLeaves = (event: FocusEvent) => {
      if (!algorithmPickerRef.current?.contains(event.target as Node)) {
        setIsAlgorithmPickerOpen(false);
      }
    };
    const closeWhenPointerLeaves = (event: PointerEvent) => {
      if (!algorithmPickerRef.current?.contains(event.target as Node)) {
        setIsAlgorithmPickerOpen(false);
      }
    };

    document.addEventListener("focusin", closeWhenFocusLeaves);
    document.addEventListener("pointerdown", closeWhenPointerLeaves, true);
    return () => {
      document.removeEventListener("focusin", closeWhenFocusLeaves);
      document.removeEventListener("pointerdown", closeWhenPointerLeaves, true);
    };
  }, [isAlgorithmPickerOpen]);

  useEffect(() => {
    // Match the former selector: switching algorithms is available while
    // paused (which resets the trace), but never while a run is advancing.
    if (isRunning) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Close a now-invalid popover when the runner takes control.
      setIsAlgorithmPickerOpen(false);
    }
  }, [isRunning]);

  const isLargeArray = originalValues.length > DEFAULT_ARRAY_SIZE;
  const playbackDensity = isBogo ? 48 : 1;
  // Use the internal 1–200 playback range for deterministic sorts, while the
  // visible control remains a simple 1–100% scale.
  // Shape one continuous curve across the full internal 1–200 range. The
  // former two-piece curve had already collapsed to the frame-delay floor by
  // 51%, so the visible 51–100% half of the control could barely affect the
  // actual runner. Keeping the curve continuous preserves the deliberately
  // slow lower half while giving every faster value a distinct cadence.
  const speedDelay = Math.round(
    4 + 716 * (1 - (playbackSpeed - 1) / (MAX_SPEED - 1)) ** 1.3,
  );
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
  // Bogo's maximum size is only 25. Do not silently turn a size-25 run into
  // a maximum-speed busy loop: the speed control needs to keep its meaning at
  // every supported Bogo size.
  const bogoSlowMotionDelay = isBogo ? getBogoSlowMotionDelay(speed) : 0;
  const usesEvenMergePacing =
    algorithm === "merge" &&
    currentStep.phase !== "ready" &&
    currentStep.phase !== "complete";
  const mergeSlowdown = 1 - (speed - 1) / (DISPLAY_SPEED_MAX - 1);
  const mergePassDuration = Math.round(600 + 6_000 * mergeSlowdown ** 1.5);
  const mergeFramesInCurrentPass = mergePassFrameCounts.get(currentStep.pass) ?? 1;
  const baseDelay = prefersReducedMotion
    ? 18
    : usesEvenMergePacing
      ? Math.max(minimumFrameDelay, mergePassDuration / mergeFramesInCurrentPass)
      // Keep the settled visual mode stable while the slider is held, but do
      // not let that temporary mode pin the runner to a slow FLIP duration.
      // The value itself must still change speed on every live slider input.
      : isSafeVisualMove && !isAdjustingSpeedControl
        ? motionSlideDuration + 100
      : Math.max(minimumFrameDelay, speedDelay / playbackDensity);
  const delay = baseDelay;
  const densePlaybackStepStride =
    !isBogo && isLargeArray && delay < DENSE_PLAYBACK_FRAME_INTERVAL
      ? Math.max(1, Math.round(DENSE_PLAYBACK_FRAME_INTERVAL / Math.max(delay, 1)))
      : 1;
  const deterministicPlaybackDelay =
    densePlaybackStepStride > 1 ? DENSE_PLAYBACK_FRAME_INTERVAL : delay;
  // Canvas playback intentionally keeps its own step index so dense rows do
  // not re-render the entire page. Merge's pacing depends on the *local*
  // merge pass, though, not React's last committed step. Supply a timing
  // resolver that can be consulted from the local runner at each boundary.
  const getDenseCanvasPlaybackTiming = useCallback(
    (candidateStep: SortStep): DensePlaybackTiming => {
      const usesMergePassPacing =
        algorithm === "merge" &&
        candidateStep.phase !== "ready" &&
        candidateStep.phase !== "complete";
      const candidateDelay = prefersReducedMotion
        ? 18
        : usesMergePassPacing
          ? Math.max(
              minimumFrameDelay,
              mergePassDuration / (mergePassFrameCounts.get(candidateStep.pass) ?? 1),
            )
          : Math.max(minimumFrameDelay, speedDelay / playbackDensity);
      const candidateStride =
        // Merge's shared pass duration is a teaching cue, not a generic
        // high-speed sampling target. Advance each logical merge frame so a
        // local Canvas runner cannot skip over a pass boundary using timing
        // calculated for the prior pass.
        algorithm !== "merge" &&
        !isBogo &&
        isLargeArray &&
        candidateDelay < DENSE_PLAYBACK_FRAME_INTERVAL
          ? Math.max(
              1,
              Math.round(DENSE_PLAYBACK_FRAME_INTERVAL / Math.max(candidateDelay, 1)),
            )
          : 1;

      return {
        stepDelay:
          candidateStride > 1 ? DENSE_PLAYBACK_FRAME_INTERVAL : candidateDelay,
        stepStride: candidateStride,
      };
    },
    [
      algorithm,
      isBogo,
      isLargeArray,
      mergePassDuration,
      mergePassFrameCounts,
      minimumFrameDelay,
      playbackDensity,
      prefersReducedMotion,
      speedDelay,
    ],
  );
  const shouldInterpolateDenseBars =
    isLargeArray &&
    !isBogo &&
    !prefersReducedMotion &&
    interpolationSpeed <= MOVE_INTERPOLATION_MAX_SPEED;
  // Dense fast playback does not need individual DOM boxes or FLIP geometry.
  // Preserve those more tactile details for slow inspection and every row up
  // to 63 values; switch only the 64–256 high-speed path to one canvas.
  const useCanvasBarRenderer =
    !isBogo &&
    supportsCanvas2D &&
    !canvasRendererUnavailable &&
    originalValues.length >= CANVAS_BAR_RENDERER_MIN_ARRAY_SIZE &&
    !shouldInterpolateMoves;
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
  // Reading every member of a 64–256-value row on every playback frame is
  // not useful to assistive technology and makes WebKit rebuild a large AX
  // string on the same cadence as the canvas. The live message below remains
  // available when a run pauses or completes, where its detail is actionable.
  const summarizeDenseRunForAccessibility =
    isLargeArray && useCanvasBarRenderer && isRunning;
  const displayValues = summarizeDenseRunForAccessibility
    ? String(currentStep.values.length) + " values"
    : renderedBarItems
        .map((item) => (item.isGap ? "open gap" : String(item.value)))
        .join(", ");
  const chartAccessibleLabel =
    summarizeDenseRunForAccessibility
      ? "Animated " + algorithmLabel + " visualization with " + displayValues + "."
      : "Array values: " + displayValues + ". " + currentStep.message;
  const liveStatusPoliteness = summarizeDenseRunForAccessibility ? "off" : "polite";
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

  // The dense canvas owns high-speed visual ticks. Its status nodes update
  // imperatively alongside the one canvas draw; React only receives the exact
  // index when playback stops or completes. This avoids reconciling the whole
  // teaching page every 80ms on WebKit while leaving controls and semantics
  // unchanged at every stable boundary.
  function applyDenseCanvasReadout(nextStep: SortStep, nextStepIndex: number) {
    if (denseWorkbenchMessageRef.current) {
      denseWorkbenchMessageRef.current.textContent = nextStep.message;
    }

    const phaseChip = densePhaseChipRef.current;
    if (phaseChip) {
      phaseChip.className = "phase-chip phase-chip--" + nextStep.phase;
      const labelNode = phaseChip.lastChild;
      if (labelNode) labelNode.textContent = getPhaseLabel(nextStep.phase);
    }

    if (denseHeldKeyRef.current) {
      const isHoldingKey = nextStep.key !== null && nextStep.gapIndex !== null;
      denseHeldKeyRef.current.classList.toggle("held-key--reserved", !isHoldingKey);
      if (denseHeldKeyValueRef.current) {
        denseHeldKeyValueRef.current.textContent = nextStep.key === null ? "" : String(nextStep.key);
      }
      if (denseHeldKeyDetailRef.current) {
        denseHeldKeyDetailRef.current.textContent =
          nextStep.gapIndex === null
            ? "gap ready for the next key"
            : "gap at slot " + (nextStep.gapIndex + 1);
      }
    }

    if (denseStagePassRef.current) {
      denseStagePassRef.current.textContent = String(nextStep.pass);
    }
    if (denseComparisonCountRef.current) {
      denseComparisonCountRef.current.textContent = String(nextStep.comparisons);
    }
    if (denseWriteCountRef.current) {
      denseWriteCountRef.current.textContent = String(nextStep.writes);
    }

    const nextProgress =
      steps.length > 1
        ? Math.round((nextStepIndex / (steps.length - 1)) * 100)
        : 0;
    if (denseProgressValueRef.current) {
      denseProgressValueRef.current.textContent = String(nextProgress);
    }
    if (denseProgressFillRef.current) {
      denseProgressFillRef.current.style.width = String(nextProgress) + "%";
    }
  }

  const handleDenseCanvasPlaybackVisualStep = (nextStep: SortStep, nextStepIndex: number) => {
    denseCanvasReadoutRef.current = {
      trace: steps,
      step: nextStep,
      stepIndex: nextStepIndex,
    };
    applyDenseCanvasReadout(nextStep, nextStepIndex);
  };

  const handleDenseCanvasAudioStep = (nextStep: SortStep) => {
    // Dense playback intentionally maps every visible working phase to the
    // reusable pulse voice. Unlike the small-row voice, it is cadence-capped
    // inside the audio engine, so run/power/select milestones stay audible
    // without creating a source per canvas frame.
    if (
      nextStep.phase !== "ready" &&
      nextStep.phase !== "complete" &&
      nextStep.phase !== "limited"
    ) {
      playSortingTone(nextStep);
    }
  };

  const handleDenseCanvasPlaybackIndex = (nextStepIndex: number) => {
    denseCanvasPlaybackStepIndexRef.current = nextStepIndex;
    denseCanvasPlaybackTraceRef.current = steps;
  };

  // A control update (for example volume or a live speed change) can make
  // React commit the last semantic `currentStep` while Canvas has already
  // painted a newer local step. Reapply the cached readout in layout before
  // paint, so that commit never visibly rewinds the narration or counters.
  useLayoutEffect(() => {
    const readout = denseCanvasReadoutRef.current;
    if (
      !useCanvasBarRenderer ||
      !isRunning ||
      !readout ||
      readout.trace !== steps
    ) {
      return;
    }

    applyDenseCanvasReadout(readout.step, readout.stepIndex);
  });

  const handleDenseCanvasPlaybackCheckpoint = useCallback(
    (nextStepIndex: number, isComplete: boolean) => {
      setStepIndex((current) => (current === nextStepIndex ? current : nextStepIndex));
      if (isComplete) setRunState("complete");
    },
    [],
  );

  const handleDenseCanvasContextUnavailable = useCallback(() => {
    setCanvasRendererUnavailable(true);
  }, []);

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

  function setBogoUnlimitedConfirmation(nextOpen: boolean) {
    bogoUnlimitedConfirmationRef.current = nextOpen;
    setBogoUnlimitedConfirmationOpen(nextOpen);
  }

  function hasActiveBogoSessionNow() {
    const session = bogoSessionRef.current;
    return isBogo && session !== null && !session.done;
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

  function getBogoWorkerPacing(): BogoWorkerPacing {
    return {
      attemptDelayMs: bogoSlowMotionDelay,
      batchBudgetMs: BOGO_FAST_BATCH_BUDGET_MILLISECONDS,
      snapshotIntervalMs: BOGO_VISUAL_UPDATE_INTERVAL,
    };
  }

  function clearBogoWorkerStartupTimer() {
    if (bogoWorkerStartupTimerRef.current === null) return;
    window.clearTimeout(bogoWorkerStartupTimerRef.current);
    bogoWorkerStartupTimerRef.current = null;
  }

  function applyBogoWorkerSession(session: BogoSession, now = performance.now()) {
    bogoSessionRef.current = session;

    const rateSample = bogoRateSampleRef.current;
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
  }

  function beginBogoRateCalibrationFromWorkerSnapshot(
    session: BogoSession,
    pending: PendingBogoWorkerRateCalibration,
    now = performance.now(),
  ) {
    pendingBogoWorkerRateCalibrationRef.current = null;
    bogoRateSampleRef.current =
      !session.done && bogoElapsedTimerRef.current.startedAt !== null
        ? {
            startedAt: now,
            startingAttempts: session.attempts,
            lastReportedAt: 0,
          }
        : null;
    restartBogoExpectedRateCalibration(session, pending.modeledShuffleRate);

    if (session.done) {
      setBogoFrozenExpectedShuffleRate(pending.modeledShuffleRate);
      setBogoExpectedRateSource("modeled");
    }
  }

  function disableBogoWorker() {
    const pendingCalibration = pendingBogoWorkerRateCalibrationRef.current;
    const latestSession = bogoSessionRef.current;
    if (
      pendingCalibration &&
      latestSession &&
      pendingCalibration.runId === bogoWorkerRunIdRef.current
    ) {
      beginBogoRateCalibrationFromWorkerSnapshot(
        latestSession,
        pendingCalibration,
      );
    } else {
      pendingBogoWorkerRateCalibrationRef.current = null;
    }
    clearBogoWorkerStartupTimer();
    activeBogoWorkerRunRef.current = null;
    const worker = bogoWorkerRef.current;
    bogoWorkerRef.current = null;
    if (worker) worker.terminate();
    setBogoWorkerUnavailable(true);
  }

  function handleBogoWorkerEvent(event: BogoWorkerEvent) {
    if (event.type === "ready") return;

    const activeRun = activeBogoWorkerRunRef.current;
    if (
      !activeRun ||
      event.runId !== activeRun.runId ||
      event.runId !== bogoWorkerRunIdRef.current
    ) {
      return;
    }

    if (event.type === "error") {
      if (event.session) applyBogoWorkerSession(event.session);
      disableBogoWorker();
      return;
    }

    activeRun.hasSnapshot = true;
    clearBogoWorkerStartupTimer();
    applyBogoWorkerSession(event.session);

    if (event.type === "configured") {
      const pendingCalibration = pendingBogoWorkerRateCalibrationRef.current;
      if (
        pendingCalibration &&
        pendingCalibration.runId === event.runId &&
        pendingCalibration.configurationId === event.configurationId
      ) {
        beginBogoRateCalibrationFromWorkerSnapshot(
          event.session,
          pendingCalibration,
        );
      }
      return;
    }

    if (event.type === "complete") {
      activeBogoWorkerRunRef.current = null;
      setRunState("complete");
    }
  }

  function getOrCreateBogoWorker() {
    if (bogoWorkerUnavailable) return null;
    if (bogoWorkerRef.current) return bogoWorkerRef.current;
    if (typeof Worker === "undefined") {
      setBogoWorkerUnavailable(true);
      return null;
    }

    try {
      const worker = new Worker(new URL("./lib/bogo.worker.ts", import.meta.url), {
        type: "module",
        name: "sortscope-bogo",
      });
      worker.onmessage = (message: MessageEvent<BogoWorkerEvent>) => {
        handleBogoWorkerEvent(message.data);
      };
      worker.onerror = () => {
        // A module worker can be blocked by an older WKWebView policy even
        // after the constructor succeeds. Fall back to the prior scheduler
        // from the latest structured-clone snapshot instead of leaving a run
        // silently stalled.
        disableBogoWorker();
      };
      bogoWorkerRef.current = worker;
      return worker;
    } catch {
      setBogoWorkerUnavailable(true);
      return null;
    }
  }

  function cancelActiveBogoWorkerRun() {
    const activeRun = activeBogoWorkerRunRef.current;
    clearBogoWorkerStartupTimer();
    pendingBogoWorkerRateCalibrationRef.current = null;
    if (!activeRun) return;

    bogoWorkerRef.current?.postMessage({
      type: "cancel",
      runId: activeRun.runId,
    });
    activeBogoWorkerRunRef.current = null;
    bogoWorkerRunIdRef.current += 1;
  }

  function beginBogoWorkerRun() {
    // Invalidate messages from a paused or just-finished predecessor before
    // the fresh session is published to React. A structured-clone snapshot can
    // otherwise arrive between state updates and briefly resurrect old values.
    cancelActiveBogoWorkerRun();
    bogoWorkerRunIdRef.current += 1;
  }

  useEffect(() => {
    return () => {
      if (bogoWorkerStartupTimerRef.current !== null) {
        window.clearTimeout(bogoWorkerStartupTimerRef.current);
        bogoWorkerStartupTimerRef.current = null;
      }
      bogoWorkerRunIdRef.current += 1;
      activeBogoWorkerRunRef.current = null;
      pendingBogoWorkerRateCalibrationRef.current = null;
      bogoWorkerRef.current?.terminate();
      bogoWorkerRef.current = null;
    };
  }, []);

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

  function releaseAudioOutput(
    output: GainNode | null,
    releaseSeconds: number,
  ) {
    if (!output) return;

    // The output itself owns the authoritative context. A replacement
    // AudioContext must never schedule automation using a timestamp from an
    // older graph, or a newly created context could leave a stale output bus
    // attached and silently cap later live voices.
    const context = output.context;
    if (context.state !== "running") {
      try {
        output.disconnect();
      } catch {
        // A closed graph is already silent and safe to forget.
      }
      return;
    }

    const now = context.currentTime;
    try {
      // Never sever an audible oscillator graph at an arbitrary waveform
      // point. That hard discontinuity is the characteristic click that was
      // still audible after a reset, mute, or late completion callback. This
      // output bus is constant until release, so it needs no automation
      // cancellation before receiving its one terminal fade.
      output.gain.setValueAtTime(Math.max(0.0001, output.gain.value), now);
      output.gain.exponentialRampToValueAtTime(0.0001, now + releaseSeconds);
    } catch {
      // A closed context cannot be automated, but its graph can still be
      // released below without retaining native audio resources.
    }

    window.setTimeout(() => {
      try {
        output.disconnect();
      } catch {
        // A prior cleanup may have already detached this one-shot bus.
      }
    }, Math.ceil(releaseSeconds * 1_000) + 8);
  }

  function stopTrackedToneSources(
    sources: Set<OscillatorNode>,
    releaseSeconds: number,
  ) {
    // Keep the source's ended listener attached: it owns the complete graph
    // teardown. Clearing only the tracking set is safe because every voice
    // removes itself idempotently when Web Audio reaches its stop time.
    [...sources].forEach((source) => {
      sources.delete(source);
      try {
        if (source.context.state !== "running") {
          // A suspended/closed audio clock cannot honour a future fade. Stop
          // at its current quantum so a later resume cannot revive this run.
          source.stop();
          source.disconnect();
          return;
        }
        source.stop(
          source.context.currentTime +
            releaseSeconds +
            AUDIO_SOURCE_STOP_PADDING_SECONDS,
        );
      } catch {
        // An oscillator that has already ended or belongs to a closed context
        // cannot contribute more work. Detach its root node defensively.
        try {
          source.disconnect();
        } catch {
          // The source may already be detached by its ended callback.
        }
      }
    });
  }

  function stopCompletionSweepSound() {
    const run = completionSweepAudioRunRef.current;
    completionSweepAudioRunRef.current = null;
    if (!run) return;

    // Reset/mute/new-run paths deliberately interrupt a completion cue. The
    // normal completion path below waits for all source `ended` events, but a
    // direct person action must be allowed to stop it right away.
    run.released = true;
    releaseAudioOutput(run.output, COMPLETION_SWEEP_OUTPUT_RELEASE_SECONDS);
    stopTrackedToneSources(
      run.sources,
      COMPLETION_SWEEP_OUTPUT_RELEASE_SECONDS,
    );
  }

  function stopLiveSortingToneSound() {
    stopDenseLiveToneVoice(LIVE_TONE_OUTPUT_RELEASE_SECONDS);
    const output = liveToneOutputRef.current;
    liveToneOutputRef.current = null;
    releaseAudioOutput(output, LIVE_TONE_OUTPUT_RELEASE_SECONDS);
    stopTrackedToneSources(liveToneSourcesRef.current, LIVE_TONE_OUTPUT_RELEASE_SECONDS);
  }

  function getLiveToneOutput(context: AudioContext) {
    const existing = liveToneOutputRef.current;
    if (existing?.context === context) return existing;
    if (existing) {
      try {
        existing.disconnect();
      } catch {
        // The retired context may already have torn down this output.
      }
      liveToneOutputRef.current = null;
    }

    const output = context.createGain();
    output.gain.setValueAtTime(1, context.currentTime);
    output.connect(context.destination);
    liveToneOutputRef.current = output;
    return output;
  }

  function disconnectDenseLiveToneVoice(voice: DenseLiveToneVoice) {
    try {
      voice.oscillator.disconnect();
      voice.filter.disconnect();
      voice.pulseEnvelope.disconnect();
      voice.releaseEnvelope.disconnect();
    } catch {
      // The source may have already been released by its own ended callback.
    }
  }

  function stopDenseLiveToneVoice(releaseSeconds: number) {
    const voice = denseLiveToneVoiceRef.current;
    if (!voice) return;
    denseLiveToneVoiceRef.current = null;

    if (voice.context.state !== "running") {
      try {
        voice.oscillator.stop();
      } catch {
        // A closed source cannot be stopped again.
      }
      disconnectDenseLiveToneVoice(voice);
      return;
    }

    const now = voice.context.currentTime;
    try {
      // The pulse envelope may contain a short event just ahead of the audio
      // clock. Fade a separate fixed-gain stage instead of cancelling that
      // native automation queue, which is where WebKit produced hard edges.
      voice.releaseEnvelope.gain.setValueAtTime(1, now);
      voice.releaseEnvelope.gain.linearRampToValueAtTime(0, now + releaseSeconds);
      voice.oscillator.stop(now + releaseSeconds + AUDIO_SOURCE_STOP_PADDING_SECONDS);
    } catch {
      // A closed native context cannot honour a release envelope. It is safe
      // to detach the graph immediately because it can no longer be audible.
      disconnectDenseLiveToneVoice(voice);
    }
  }

  function playDenseTonePulse(
    context: AudioContext,
    startTime: number,
    frequency: number,
    peakGain: number,
  ) {
    let voice = denseLiveToneVoiceRef.current;
    if (voice && voice.context !== context) {
      // Rebuilding a closed/interrupted context must never leave the prior
      // native graph attached to the new output device.
      disconnectDenseLiveToneVoice(voice);
      denseLiveToneVoiceRef.current = null;
      voice = null;
    }

    if (voice) {
      const pulse = getDenseTonePulseWindow(
        voice.lastPulseEndTime,
        startTime,
        DENSE_TONE_PULSE_ATTACK_SECONDS,
        DENSE_TONE_PULSE_HOLD_SECONDS,
        DENSE_TONE_PULSE_RELEASE_SECONDS,
        DENSE_TONE_MIN_SILENCE_SECONDS,
      );
      if (!pulse) return;
      try {
        // Retune only while the pulse is silent, then gate a short envelope.
        // The oscillator stays phase-continuous and no source is allocated or
        // stopped for an individual sorting event.
        voice.oscillator.frequency.setValueAtTime(frequency, pulse.startTime);
        voice.pulseEnvelope.gain.setValueAtTime(0, pulse.startTime);
        voice.pulseEnvelope.gain.linearRampToValueAtTime(
          peakGain,
          pulse.attackEndTime,
        );
        voice.pulseEnvelope.gain.setValueAtTime(
          peakGain,
          pulse.releaseStartTime,
        );
        voice.pulseEnvelope.gain.linearRampToValueAtTime(0, pulse.endTime);
        voice.lastPulseEndTime = pulse.endTime;
      } catch {
        // A context that is in the middle of closing is handled by the next
        // user gesture, which creates a fresh voice through ensureAudioContext.
      }
      return;
    }

    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const pulseEnvelope = context.createGain();
    const releaseEnvelope = context.createGain();
    const output = getLiveToneOutput(context);
    const firstPulse = getDenseTonePulseWindow(
      null,
      startTime,
      DENSE_TONE_PULSE_ATTACK_SECONDS,
      DENSE_TONE_PULSE_HOLD_SECONDS,
      DENSE_TONE_PULSE_RELEASE_SECONDS,
      DENSE_TONE_MIN_SILENCE_SECONDS,
    );
    if (!firstPulse) return;
    const createdVoice: DenseLiveToneVoice = {
      context,
      oscillator,
      filter,
      pulseEnvelope,
      releaseEnvelope,
      lastPulseEndTime: firstPulse.endTime,
    };

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, startTime);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2_000, startTime);
    filter.Q.setValueAtTime(0.35, startTime);
    pulseEnvelope.gain.setValueAtTime(0, context.currentTime);
    pulseEnvelope.gain.setValueAtTime(0, firstPulse.startTime);
    pulseEnvelope.gain.linearRampToValueAtTime(
      peakGain,
      firstPulse.attackEndTime,
    );
    pulseEnvelope.gain.setValueAtTime(peakGain, firstPulse.releaseStartTime);
    pulseEnvelope.gain.linearRampToValueAtTime(0, firstPulse.endTime);
    releaseEnvelope.gain.setValueAtTime(1, context.currentTime);
    oscillator.connect(filter);
    filter.connect(pulseEnvelope);
    pulseEnvelope.connect(releaseEnvelope);
    releaseEnvelope.connect(output);
    denseLiveToneVoiceRef.current = createdVoice;
    oscillator.addEventListener("ended", () => {
      if (denseLiveToneVoiceRef.current === createdVoice) {
        denseLiveToneVoiceRef.current = null;
      }
      disconnectDenseLiveToneVoice(createdVoice);
    }, { once: true });
    oscillator.start(startTime);
  }

  function tryReleaseCompletedCompletionSweepAudioRun(run: CompletionSweepAudioRun) {
    if (
      run.released ||
      !isCompletionSweepAudioFinished(
        run.schedulingComplete,
        run.pendingVoiceCount,
      )
    ) {
      return;
    }

    run.released = true;
    if (completionSweepAudioRunRef.current === run) {
      completionSweepAudioRunRef.current = null;
    }

    // All oscillator envelopes have already reached silence before their
    // `ended` events fire, so this direct disconnect cannot create a click.
    // Most importantly, it is driven by the AudioContext timeline rather than
    // a wall-clock timer that may run while that timeline is interrupted.
    try {
      run.output.disconnect();
    } catch {
      // The output may have been detached by an explicit reset in the same
      // event turn.
    }
  }

  function registerCompletionSweepVoice(run: CompletionSweepAudioRun) {
    run.pendingVoiceCount += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      run.pendingVoiceCount = Math.max(0, run.pendingVoiceCount - 1);
      tryReleaseCompletedCompletionSweepAudioRun(run);
    };
  }

  function markCompletionSweepAudioSchedulingComplete(run: CompletionSweepAudioRun) {
    run.schedulingComplete = true;
    tryReleaseCompletedCompletionSweepAudioRun(run);
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
        playCompletionSweepSound(sweepValues, duration, sweepRun);
      }).catch(() => undefined);
    }

    completionSweepEndTimerRef.current = window.setTimeout(() => {
      completionSweepEndTimerRef.current = null;
      if (completionSweepRunRef.current !== sweepRun) return;
      // Visual completion is independent from the native audio lifetime.
      // `resume()` can resolve late under load, so stopping audio here used to
      // cut a just-started completion cue down to a click or silence.
      setCompletionSweepActive(false);
    }, duration + COMPLETION_SWEEP_AUDIO_VISUAL_LEAD + COMPLETION_SWEEP_RELEASE_TAIL);
  }

  function retireClosedAudioContext(closedContext: AudioContext) {
    if (audioContextRef.current !== closedContext) return;

    // A closed context cannot deliver source-ended events or a release
    // envelope. Invalidate every graph tied to it before building another
    // context so the fresh one never inherits stale output buses, source
    // caps, a pending completion run, or a casino player from the dead graph.
    if (completionSweepStartTimerRef.current !== null) {
      window.clearTimeout(completionSweepStartTimerRef.current);
      completionSweepStartTimerRef.current = null;
    }
    if (completionSweepEndTimerRef.current !== null) {
      window.clearTimeout(completionSweepEndTimerRef.current);
      completionSweepEndTimerRef.current = null;
    }
    completionSweepRunRef.current += 1;
    completionSweepStartedRef.current = false;
    stopCompletionSweepSound();
    stopLiveSortingToneSound();
    clearBogoPracticeInteraction();
    lastToneTimeRef.current = 0;
    lastBogoTextureTimeRef.current = 0;
    audioContextRef.current = null;
    setCompletionSweepActive(false);
  }

  function ensureAudioContext() {
    let context = audioContextRef.current;

    // A WebKit context can become `interrupted` when macOS changes audio
    // routes, and a closed context can no longer be resumed. Recreate only
    // the latter; every non-running live state gets a fresh resume request.
    if (context?.state === "closed") {
      retireClosedAudioContext(context);
      context = null;
    }
    if (!context) {
      const audioWindow = window as AudioContextWindow;
      const AudioContextClass = audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("This webview does not provide Web Audio output.");
      }
      context = new AudioContextClass();
      audioContextRef.current = context;
    }

    if (context.state !== "running") {
      void context.resume().catch(() => undefined);
    }

    return context;
  }

  function activateAudioOutput() {
    const context = ensureAudioContext();
    if (context.state === "running") return context;

    // WKWebView requires media to be initiated within a real gesture. Resume
    // alone is not reliable in every Apple WebKit version, so enqueue a
    // one-sample, zero-valued buffer in the same call stack. It is inaudible,
    // creates no persistent source, and unlocks the normal synth/casino path
    // before their asynchronous scheduling begins.
    try {
      const unlockSource = context.createBufferSource();
      const sampleRate = Math.max(8_000, context.sampleRate || 44_100);
      unlockSource.buffer = context.createBuffer(1, 1, sampleRate);
      // The one-sample buffer is initialized to zero, so a direct connection
      // is still inaudible while being less likely to be optimized away by a
      // WebKit audio graph before it has fully activated.
      unlockSource.connect(context.destination);
      unlockSource.addEventListener("ended", () => {
        unlockSource.disconnect();
      }, { once: true });
      unlockSource.start(context.currentTime);
      unlockSource.stop(context.currentTime + 1 / sampleRate);
    } catch {
      // `resume()` below remains a useful fallback for hosts that reject a
      // buffer until their output device is fully available.
    }

    void context.resume().catch(() => undefined);
    return context;
  }

  audioGestureActivatorRef.current = activateAudioOutput;

  function playMusicalVoice(
    context: AudioContext,
    startTime: number,
    frequency: number,
    targetDuration: number,
    peakGain: number,
    trackedSources?: Set<OscillatorNode>,
    output: AudioNode = context.destination,
    onVoiceEnded?: () => void,
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
    envelope.connect(output);

    // Oscillators stop themselves, but Web Audio does not automatically
    // disconnect the filter/gain graph that they were connected through.
    // Leaving those finished graphs attached caused long high-speed sessions
    // to retain thousands of silent nodes, eventually starving the audio
    // renderer (especially in WKWebView). Tear the whole voice down only
    // after both oscillators finish so the octave cannot be cut off early.
    let endedOscillators = 0;
    let released = false;
    const releaseVoice = () => {
      if (released || endedOscillators < 2) return;
      released = true;
      try {
        fundamental.disconnect();
        octave.disconnect();
        fundamentalLevel.disconnect();
        octaveLevel.disconnect();
        rumbleFilter.disconnect();
        toneFilter.disconnect();
        envelope.disconnect();
      } catch {
        // Disconnect is idempotent in practice, but a closed context can
        // reject it while the host is shutting down.
      }
      onVoiceEnded?.();
    };
    const onOscillatorEnded = (oscillator: OscillatorNode) => {
      trackedSources?.delete(oscillator);
      endedOscillators += 1;
      releaseVoice();
    };
    fundamental.addEventListener("ended", () => onOscillatorEnded(fundamental), { once: true });
    octave.addEventListener("ended", () => onOscillatorEnded(octave), { once: true });
    trackedSources?.add(fundamental);
    trackedSources?.add(octave);

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
    if (!context || step.values.length === 0) return;
    if (context.state === "closed") {
      // A long-running visualizer can outlive an OS audio-route reset. Start
      // recovery on this checkpoint; the next one will use the fresh graph.
      ensureAudioContext();
      return;
    }
    if (context.state !== "running") {
      // macOS can transiently report an interrupted context while the WebView
      // is under load. A single early return used to turn that brief state
      // into an entire silent run because nothing retried the resume.
      void context.resume().catch(() => undefined);
      return;
    }

    const volume = soundVolumeRef.current;
    if (volume <= 0) return;

    const isDenseTone = usesContinuousDenseTone(originalValues.length);
    const now = context.currentTime;
    if (!isDenseTone) {
      const cooldown = 0.028;
      if (now - lastToneTimeRef.current < cooldown) return;
      lastToneTimeRef.current = now;
    }

    const activeIndex = step.inserting ?? step.comparing ?? step.shifting;
    const activeValue =
      activeIndex === null || activeIndex === undefined
        ? step.key ?? step.values[0] ?? 1
        : step.values[Math.min(step.values.length - 1, Math.max(0, activeIndex))] ?? step.key ?? 1;
    const isImpact =
      step.phase === "swap" ||
      step.phase === "shift" ||
      step.phase === "insert" ||
      step.phase === "merge";
    const targetDuration = isImpact ? 0.052 : 0.034;
    const basePeakGain = isImpact ? 0.2 : 0.14;
    const peakGain = basePeakGain * (volume / 100) ** 2.5;
    const frequency = getSortingToneFrequency(activeValue);
    // Preserve the immediate, musical response for the 4–25 note piano
    // mapping. Dense pulse rows receive scheduling lead so a lagged render
    // cannot reach the oscillator before its click-free attack is queued.
    const startTime = isDenseTone
      ? getSafeScheduledAudioTime(
          now,
          context.currentTime,
          DENSE_TONE_SCHEDULE_LEAD_SECONDS,
        )
      : now;

    if (isDenseTone) {
      // Dense rows reuse one oscillator internally, but its gain gate makes
      // every accepted checkpoint a separate short burst with silence after
      // it. This avoids source churn without turning the run into one tone.
      playDenseTonePulse(
        context,
        startTime,
        frequency,
        Math.min(0.25, peakGain * 1.25),
      );
      return;
    }

    const output = getLiveToneOutput(context);

    // Two oscillators make up each small, musical piano voice. A hard cap
    // keeps a delayed Web Audio backend from accumulating work faster than it
    // can render when several state changes land in one frame.
    if (liveToneSourcesRef.current.size + 2 > MAX_LIVE_TONE_SOURCES) return;
    playMusicalVoice(
      context,
      startTime,
      frequency,
      targetDuration,
      peakGain,
      liveToneSourcesRef.current,
      output,
    );
  }

  function playDenseCompletionSweep(
    context: AudioContext,
    valuesToScan: readonly number[],
    startTime: number,
    duration: number,
    peakGain: number,
    output: AudioNode,
    run: CompletionSweepAudioRun,
    onVoiceEnded: () => void,
  ) {
    // A 256-value finish used to allocate 256 oscillators and 256 envelopes
    // over roughly one second. On a lagged WebKit renderer that created a
    // burst of native-audio work precisely when the visualizer was busiest.
    // A single phase-continuous oscillator with one frequency automation point
    // per value keeps the one-note-per-bar rule while eliminating that spike.
    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    const spacing = duration / 1_000 / valuesToScan.length;
    const attack = Math.min(0.012, Math.max(0.004, spacing * 0.75));
    const release = 0.02;
    const endTime = startTime + duration / 1_000;
    const bodyEnd = Math.max(startTime + attack, endTime - release);

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(
      getSortingToneFrequency(valuesToScan[0] ?? 1),
      startTime,
    );
    valuesToScan.forEach((value, index) => {
      const noteTime = startTime + (index + 0.5) * spacing;
      const frequency = getSortingToneFrequency(value);
      // Linear ramps keep phase continuous—unlike restarting hundreds of
      // oscillators—while each value still contributes its own pitch point.
      oscillator.frequency.linearRampToValueAtTime(frequency, noteTime);
    });
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2_000, startTime);
    filter.Q.setValueAtTime(0.4, startTime);
    envelope.gain.setValueAtTime(0.0001, startTime);
    envelope.gain.exponentialRampToValueAtTime(peakGain, startTime + attack);
    envelope.gain.setValueAtTime(peakGain, bodyEnd);
    envelope.gain.exponentialRampToValueAtTime(0.0001, endTime + release);

    oscillator.connect(filter);
    filter.connect(envelope);
    envelope.connect(output);
    run.sources.add(oscillator);
    oscillator.addEventListener("ended", () => {
      run.sources.delete(oscillator);
      try {
        oscillator.disconnect();
        filter.disconnect();
        envelope.disconnect();
      } catch {
        // The shared output can be released before its voice ends.
      }
      onVoiceEnded();
    }, { once: true });
    oscillator.start(startTime);
    oscillator.stop(endTime + release + AUDIO_SOURCE_STOP_PADDING_SECONDS);
  }

  function playCompletionSweepSound(
    sweepValues: number[],
    duration: number,
    sweepRun: number,
  ) {
    const context = audioContextRef.current;
    const volume = soundVolumeRef.current;
    if (
      completionSweepRunRef.current !== sweepRun ||
      !context ||
      context.state !== "running" ||
      volume <= 0
    ) return;

    const valuesToScan = sweepValues.length ? sweepValues : originalValues;
    if (valuesToScan.length === 0) return;

    const startTime = context.currentTime + COMPLETION_SWEEP_AUDIO_VISUAL_LEAD / 1_000;
    const liveImpactPeak = 0.2 * (volume / 100) ** 2.5;
    const useCompactVoice = usesContinuousDenseTone(valuesToScan.length);
    // Give a sweep its own output bus. It lets the end/reset path release a
    // current tone smoothly rather than stopping a waveform at a hard edge.
    const output = context.createGain();
    output.gain.setValueAtTime(1, context.currentTime);
    output.connect(context.destination);
    const run: CompletionSweepAudioRun = {
      id: sweepRun,
      context,
      output,
      sources: new Set<OscillatorNode>(),
      pendingVoiceCount: 0,
      schedulingComplete: false,
      released: false,
    };
    completionSweepAudioRunRef.current = run;
    if (useCompactVoice) {
      const onVoiceEnded = registerCompletionSweepVoice(run);
      try {
        playDenseCompletionSweep(
          context,
          valuesToScan,
          startTime,
          duration,
          0.16 * (volume / 100) ** 2.5,
          output,
          run,
          onVoiceEnded,
        );
      } catch {
        // A route can disappear after `resume()` resolves. Mark the failed
        // voice as complete so this run cannot retain an orphaned output bus.
        onVoiceEnded();
      }
      markCompletionSweepAudioSchedulingComplete(run);
      return;
    }

    const spacing = duration / 1_000 / valuesToScan.length;
    valuesToScan.forEach((value, index) => {
      const noteTime = startTime + (index + 0.5) * spacing;
      const frequency = getSortingToneFrequency(value);
      const requestedDuration = Math.min(0.052, Math.max(0.012, spacing * 0.9));
      const actualVoiceDuration = Math.min(
        0.12,
        Math.max(requestedDuration, 4.5 / Math.max(frequency, 1)),
      );
      const overlap = Math.max(1, actualVoiceDuration / spacing);
      const onVoiceEnded = registerCompletionSweepVoice(run);
      try {
        playMusicalVoice(
          context,
          noteTime,
          frequency,
          requestedDuration,
          liveImpactPeak / Math.sqrt(overlap),
          run.sources,
          output,
          onVoiceEnded,
        );
      } catch {
        onVoiceEnded();
      }
    });
    markCompletionSweepAudioSchedulingComplete(run);
  }

  function playBogoShuffleTexture(attempt: number) {
    const context = audioContextRef.current;
    const volume = soundVolumeRef.current;
    if (!context || volume <= 0) return;
    if (context.state === "closed") {
      ensureAudioContext();
      return;
    }
    if (context.state !== "running") return;

    const now = context.currentTime;
    if (now - lastBogoTextureTimeRef.current < 0.13) return;
    lastBogoTextureTimeRef.current = now;

    const motion = ((attempt * 0.61803398875) % 1 + 1) % 1;
    // Bogo is throttled independently, but its audible hit uses the same
    // reinforced voice and impact level as a regular sorting move. The prior
    // one-oscillator bandpass texture was being attenuated enough to sound
    // markedly quieter than the rest of the visualizer.
    const frequency = 293.66 + motion * 340;
    const peakGain = 0.2 * (volume / 100) ** 2.5;
    if (liveToneSourcesRef.current.size + 2 > MAX_LIVE_TONE_SOURCES) return;
    playMusicalVoice(
      context,
      now,
      frequency,
      0.075,
      peakGain,
      liveToneSourcesRef.current,
      getLiveToneOutput(context),
    );
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
      oscillator.addEventListener("ended", () => {
        try {
          oscillator.disconnect();
          gain.disconnect();
        } catch {
          // The app may have released the context while the victory tail ran.
        }
      }, { once: true });
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
      if (practiceCelebrationFadeTimerRef.current !== null) {
        window.clearTimeout(practiceCelebrationFadeTimerRef.current);
      }
      if (practiceCelebrationUnmountTimerRef.current !== null) {
        window.clearTimeout(practiceCelebrationUnmountTimerRef.current);
      }
      clearBogoPracticeInteraction(false);
      practiceCelebrationRunRef.current += 1;
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

  // Keep the raw PCM clips in memory before a person presses a button. The
  // actual output still starts only from a later user gesture. We intentionally
  // do not use `new Audio()` here: Linux WebKitGTK routes media elements through
  // its GStreamer packaging path, while the existing sorting notes prove that
  // AudioContext output is reliable in the desktop app.
  useEffect(() => {
    const clipLoads = bogoPracticeAudioClipLoadsRef.current;
    const sounds = Object.keys(BOGO_PRACTICE_CASINO_SOUNDS) as BogoPracticeCasinoSound[];
    sounds.forEach((sound) => {
      void loadBogoPracticeCasinoClip(sound).catch(() => undefined);
    });
    return () => {
      clipLoads.clear();
    };
  }, []);

  // Keep an active casino buffer in step with the shared volume control.
  useEffect(() => {
    const context = audioContextRef.current;
    const gain = bogoPracticeAudioGainRef.current;
    if (!context || !gain) return;

    const nextGain = Math.max(
      0,
      Math.min(1, (soundVolume / 100) * BOGO_PRACTICE_CASINO_GAIN),
    );
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setTargetAtTime(nextGain, context.currentTime, 0.012);
  }, [soundVolume]);

  useEffect(() => {
    const usesDenseTone = usesContinuousDenseTone(originalValues.length);
    const hasAudibleDenseCheckpoint =
      currentStep.phase !== "ready" &&
      currentStep.phase !== "complete" &&
      currentStep.phase !== "limited";
    if (
      isBogo ||
      !soundEnabled ||
      runState !== "running" ||
      (!usesDenseTone && stepIndex === 0) ||
      (usesDenseTone
        ? !hasAudibleDenseCheckpoint
        : !AUDIBLE_PHASES.includes(currentStep.phase))
    ) {
      return;
    }

    playSortingTone(currentStep);
  }, [currentStep, isBogo, originalValues.length, runState, soundEnabled, stepIndex]);

  // A dense row owns one reusable pulse graph while it is running. Release it
  // as soon as the runner pauses, completes, or mutes; waiting for another
  // React step would retain an unnecessary native source after motion stops.
  useEffect(() => {
    if (soundEnabled && runState === "running") return;
    stopLiveSortingToneSound();
  }, [runState, soundEnabled]);

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
    if (!isBogo) {
      cancelActiveBogoWorkerRun();
      return;
    }

    const session = bogoSessionRef.current;
    if (!session || session.done) {
      if (!session) cancelActiveBogoWorkerRun();
      return;
    }
    if (bogoWorkerUnavailable) return;

    const worker = bogoWorkerRef.current;
    if (!worker) return;

    const runId = bogoWorkerRunIdRef.current;
    const pacing = getBogoWorkerPacing();
    const activeRun = activeBogoWorkerRunRef.current;
    if (!activeRun || activeRun.runId !== runId) {
      activeBogoWorkerRunRef.current = { runId, hasSnapshot: false };
      worker.postMessage({ type: "start", runId, session, pacing });
      clearBogoWorkerStartupTimer();
      bogoWorkerStartupTimerRef.current = window.setTimeout(() => {
        const pendingRun = activeBogoWorkerRunRef.current;
        if (pendingRun?.runId === runId && !pendingRun.hasSnapshot) {
          disableBogoWorker();
        }
      }, BOGO_WORKER_STARTUP_TIMEOUT);
      return;
    }

    worker.postMessage({
      type: "configure",
      runId,
      configurationId: bogoWorkerConfigurationIdRef.current,
      pacing,
    });
    worker.postMessage({
      type: runState === "running" ? "resume" : "pause",
      runId,
    });
  }, [bogoSlowMotionDelay, bogoWorkerUnavailable, isBogo, runState, speed]);

  useEffect(() => {
    // Keep the original event-loop runner as a compatibility path for hosts
    // that reject a Vite module Worker. Normal desktop builds leave this path
    // dormant, so their heavy Bogo loop never competes with paint or WebAudio.
    if (!isBogo || !bogoWorkerUnavailable || runState !== "running") return;

    const session = bogoSessionRef.current;
    if (!session) return;

    let cancelled = false;
    let timer: number | undefined;
    let animationFrame: number | undefined;
    let nextVisualUpdateAt = 0;
    let nextCooperativeYieldAt = performance.now();

    const isInputPending = () => {
      if (typeof navigator === "undefined") return false;

      const scheduling = (navigator as Navigator & {
        scheduling?: { isInputPending?: () => boolean };
      }).scheduling;
      return scheduling?.isInputPending?.() ?? false;
    };

    const scheduleNextBatch = () => {
      if (bogoSlowMotionDelay > 0) {
        timer = window.setTimeout(runBatch, bogoSlowMotionDelay);
        return;
      }

      const now = performance.now();
      if (isInputPending() || now >= nextCooperativeYieldAt) {
        // Browser timers let this runner use more than one small CPU slice per
        // rendered frame, which materially improves Bogo throughput. Every
        // short burst still ends at a frame boundary (or earlier when Chromium
        // reports queued input), keeping the desktop UI responsive.
        animationFrame = window.requestAnimationFrame(() => {
          nextCooperativeYieldAt =
            performance.now() + BOGO_FAST_COOPERATIVE_YIELD_MILLISECONDS;
          runBatch();
        });
        return;
      }

      timer = window.setTimeout(runBatch, 0);
    };

    const runBatch = () => {
      if (cancelled || bogoSessionRef.current !== session) return;

      if (bogoSlowMotionDelay > 0) {
        advanceBogoSession(session);
      } else {
        const deadline = performance.now() + BOGO_FAST_BATCH_BUDGET_MILLISECONDS;
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

      // `getBogoSessionStep` clones the row and feeds the full visualizer
      // tree. At the fast end the CPU loop can complete hundreds of batches a
      // second, which used to turn every batch into a full React render and
      // make the desktop app unresponsive. The simulation and its measured
      // rate remain continuous; only the visual snapshot is coalesced. Always
      // flush the terminal state immediately so the completion still lands on
      // the exact winning (or limited) shuffle.
      if (session.done || now >= nextVisualUpdateAt) {
        nextVisualUpdateAt = now + BOGO_VISUAL_UPDATE_INTERVAL;
        setBogoLiveStep(getBogoSessionStep(session));
      }
      if (session.done) {
        setRunState("complete");
        return;
      }

      scheduleNextBatch();
    };

    scheduleNextBatch();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    };
  }, [bogoModeledShuffleRate, bogoSlowMotionDelay, bogoWorkerUnavailable, isBogo, runState]);

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
    if (isBogo || useCanvasBarRenderer || runState !== "running" || steps.length === 0) return;

    const timer = window.setTimeout(() => {
      if (stepIndex >= steps.length - 1) {
        setRunState("complete");
        return;
      }

      // Dense arrays at maximum speed may have a large number of compact
      // snapshots. Batch those logical steps into a single display frame; the
      // final snapshot, counters, and completion sequence remain exact.
      const nextIndex = Math.min(
        steps.length - 1,
        stepIndex + densePlaybackStepStride,
      );
      setStepIndex(nextIndex);
      if (nextIndex === steps.length - 1) {
        setRunState("complete");
      }
    }, deterministicPlaybackDelay);

    return () => window.clearTimeout(timer);
  }, [
    densePlaybackStepStride,
    deterministicPlaybackDelay,
    isBogo,
    runState,
    stepIndex,
    steps,
    useCanvasBarRenderer,
  ]);

  function createNewArray(
    size = arraySize,
    arrangement: ArrayArrangement = arrayArrangement,
  ) {
    resetCompletionSweep();
    resetBogoElapsedTimer();
    setBogoUnlimitedConfirmation(false);
    const nextValues = makeArrayForArrangement(size, arrangement);
    setBogoCelebrationPhase("hidden");
    cancelActiveBogoWorkerRun();
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

  function handleArrayArrangementChange(nextArrangement: ArrayArrangement) {
    setArrayArrangement(nextArrangement);
    // Switching arrangement is an intentional fresh input, so it safely
    // abandons any ready, paused, or completed trace and redraws immediately.
    createNewArray(arraySize, nextArrangement);
  }

  function resetArray() {
    resetCompletionSweep();
    resetBogoElapsedTimer();
    setBogoUnlimitedConfirmation(false);
    setBogoCelebrationPhase("hidden");
    cancelActiveBogoWorkerRun();
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
    // Keep asynchronous interval/sweep callbacks in sync immediately; waiting
    // for React to repaint can leave one more high-speed tone queued after a
    // person has muted the visualizer.
    soundVolumeRef.current = nextVolume;
    if (nextVolume <= 0) {
      stopCompletionSweepSound();
      stopLiveSortingToneSound();
    } else if (soundVolume === 0) {
      activateAudioOutput();
    }
    setSoundVolume(nextVolume);
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

  function loadBogoPracticeCasinoClip(sound: BogoPracticeCasinoSound) {
    const existingLoad = bogoPracticeAudioClipLoadsRef.current.get(sound);
    if (existingLoad) return existingLoad;

    const { source } = BOGO_PRACTICE_CASINO_SOUNDS[sound];
    const load = fetch(source)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Casino audio could not be loaded.");
        }
        return response.arrayBuffer();
      })
      .then(decodePcmWav);

    bogoPracticeAudioClipLoadsRef.current.set(sound, load);
    void load.catch(() => {
      // A transient local-protocol failure should not poison every later
      // click. Let the next cue attempt a fresh request instead.
      if (bogoPracticeAudioClipLoadsRef.current.get(sound) === load) {
        bogoPracticeAudioClipLoadsRef.current.delete(sound);
      }
    });
    return load;
  }

  function releaseBogoPracticeAudio(
    source: AudioBufferSourceNode,
    gain: GainNode | null,
    { stop = true }: { stop?: boolean } = {},
  ) {
    // Every casino cue is a strictly one-shot buffer source. Stopping and
    // disconnecting it before the next cue prevents rapid Gamble clicks from
    // retaining an old tail or accumulating a playback backlog.
    source.onended = null;
    if (stop) {
      try {
        source.stop();
      } catch {
        // Stopping an already-ended buffer is intentionally harmless.
      }
    }
    source.disconnect();
    gain?.disconnect();
  }

  function clearBogoPracticeAudio() {
    bogoPracticeAudioRunRef.current += 1;
    if (bogoPracticeAudioTimerRef.current !== null) {
      window.clearTimeout(bogoPracticeAudioTimerRef.current);
      bogoPracticeAudioTimerRef.current = null;
    }

    const source = bogoPracticeAudioSourceRef.current;
    const gain = bogoPracticeAudioGainRef.current;
    bogoPracticeAudioSourceRef.current = null;
    bogoPracticeAudioGainRef.current = null;
    if (!source) {
      try {
        gain?.disconnect();
      } catch {
        // A source can fail after connecting its gain node; the lone output
        // still must not survive a context replacement.
      }
      return;
    }
    releaseBogoPracticeAudio(source, gain);
  }

  function beginBogoPracticeCasinoAction() {
    bogoPracticeCasinoActionRef.current += 1;
    // A new Gamble deliberately interrupts the prior failure sting. Clearing
    // the native player here—not merely when the next shuffle eventually
    // starts—keeps repeated clicks from leaving a delayed sound backlog.
    clearBogoPracticeAudio();
    return bogoPracticeCasinoActionRef.current;
  }

  function clearBogoPracticeRoll(updateState = true) {
    bogoPracticeRollRunRef.current += 1;
    if (bogoPracticeRollIntervalRef.current !== null) {
      window.clearInterval(bogoPracticeRollIntervalRef.current);
      bogoPracticeRollIntervalRef.current = null;
    }
    if (updateState) setBogoPracticeRolling(false);
  }

  function clearBogoPracticeInteraction(updateState = true) {
    bogoPracticeCasinoActionRef.current += 1;
    clearBogoPracticeRoll(updateState);
    clearBogoPracticeAudio();
    if (updateState) setBogoPracticeBusy(false);
  }

  function playBogoPracticeCasinoSound(
    sound: BogoPracticeCasinoSound,
    onSettled: () => void,
    onStarted: () => void = () => undefined,
    casinoActionRun = bogoPracticeCasinoActionRef.current,
  ) {
    if (bogoPracticeCasinoActionRef.current !== casinoActionRun) return;
    clearBogoPracticeAudio();
    const soundRun = bogoPracticeAudioRunRef.current + 1;
    bogoPracticeAudioRunRef.current = soundRun;
    const { silentDuration } = BOGO_PRACTICE_CASINO_SOUNDS[sound];
    let settled = false;
    let playbackStarted = false;
    let sequenceStarted = false;
    let usingTimedFallback = false;

    let activeSource: AudioBufferSourceNode | null = null;
    let activeGain: GainNode | null = null;

    const isCurrentCue = () =>
      bogoPracticeCasinoActionRef.current === casinoActionRun &&
      bogoPracticeAudioRunRef.current === soundRun;

    const clearAudioTimer = () => {
      if (bogoPracticeAudioTimerRef.current === null) return;
      window.clearTimeout(bogoPracticeAudioTimerRef.current);
      bogoPracticeAudioTimerRef.current = null;
    };

    const startSequence = () => {
      if (settled || sequenceStarted || !isCurrentCue()) return;
      sequenceStarted = true;
      onStarted();
    };

    const settle = () => {
      if (settled || !isCurrentCue()) return;
      settled = true;
      clearAudioTimer();

      if (activeSource) {
        if (bogoPracticeAudioSourceRef.current === activeSource) {
          bogoPracticeAudioSourceRef.current = null;
          bogoPracticeAudioGainRef.current = null;
        }
        releaseBogoPracticeAudio(activeSource, activeGain, { stop: false });
        activeSource = null;
        activeGain = null;
      }
      onSettled();
    };

    const scheduleTimedFallback = () => {
      if (
        settled ||
        playbackStarted ||
        usingTimedFallback ||
        !isCurrentCue()
      ) {
        return;
      }
      usingTimedFallback = true;
      clearAudioTimer();
      startSequence();
      bogoPracticeAudioTimerRef.current = window.setTimeout(settle, silentDuration);
    };

    // A silent volume still preserves the same paced visual lesson; it simply
    // skips creating a Web Audio source. Successful playback advances only
    // from `ended`; the timer is reserved for muted or unavailable clips.
    if (soundVolumeRef.current > 0) {
      // Open/resume synchronously from the click that invoked this function.
      // That preserves the browser's user-activation requirement even if the
      // local clip finishes fetching a moment later.
      const context = activateAudioOutput();

      // Protect the disabled lesson from an unavailable local asset or output
      // device. Once a buffer starts, this watchdog is cleared and can never
      // cut off a healthy cue.
      bogoPracticeAudioTimerRef.current = window.setTimeout(
        scheduleTimedFallback,
        BOGO_PRACTICE_CASINO_STARTUP_TIMEOUT,
      );

      void Promise.all([context.resume(), loadBogoPracticeCasinoClip(sound)])
        .then(([, clip]) => {
          if (settled || usingTimedFallback || !isCurrentCue()) return;
          if (audioContextRef.current !== context || context.state !== "running") {
            // The click's context was retired while its clip was loading.
            // Never attach a newly decoded casino graph to that dead context.
            scheduleTimedFallback();
            return;
          }

          const buffer = context.createBuffer(
            clip.numberOfChannels,
            clip.frameCount,
            clip.sampleRate,
          );
          clip.channelData.forEach((channel, index) => buffer.copyToChannel(channel, index));

          const source = context.createBufferSource();
          const gain = context.createGain();
          source.buffer = buffer;
          source.loop = false;
          gain.gain.setValueAtTime(
            Math.max(
              0,
              Math.min(1, (soundVolumeRef.current / 100) * BOGO_PRACTICE_CASINO_GAIN),
            ),
            context.currentTime,
          );
          source.connect(gain);
          gain.connect(context.destination);
          activeSource = source;
          activeGain = gain;
          bogoPracticeAudioSourceRef.current = source;
          bogoPracticeAudioGainRef.current = gain;
          source.onended = settle;

          try {
            source.start();
          } catch {
            releaseBogoPracticeAudio(source, gain);
            if (bogoPracticeAudioSourceRef.current === source) {
              bogoPracticeAudioSourceRef.current = null;
              bogoPracticeAudioGainRef.current = null;
            }
            activeSource = null;
            activeGain = null;
            scheduleTimedFallback();
            return;
          }

          playbackStarted = true;
          clearAudioTimer();
          startSequence();
        })
        .catch(scheduleTimedFallback);
    } else {
      // With sound muted there is no media event to await, so preserve the
      // same readable pacing without constructing a silent player.
      scheduleTimedFallback();
    }
  }

  function clearPracticeCelebration() {
    // Bump the generation even when there is no visible overlay. That makes a
    // delayed AudioContext resume from a just-reset lesson harmless.
    practiceCelebrationRunRef.current += 1;
    if (practiceCelebrationFadeTimerRef.current !== null) {
      window.clearTimeout(practiceCelebrationFadeTimerRef.current);
      practiceCelebrationFadeTimerRef.current = null;
    }
    if (practiceCelebrationUnmountTimerRef.current !== null) {
      window.clearTimeout(practiceCelebrationUnmountTimerRef.current);
      practiceCelebrationUnmountTimerRef.current = null;
    }
    setPracticeCelebrationPhase("hidden");
  }

  function startPracticeCelebration({ playVictorySound = true } = {}) {
    if (practiceCompletionRef.current) return;

    practiceCompletionRef.current = true;
    clearPracticeCelebration();
    const celebrationRun = practiceCelebrationRunRef.current;
    setPracticeCelebrationPhase("visible");

    if (soundEnabled && playVictorySound) {
      const context = ensureAudioContext();
      void context
        .resume()
        .then(() => {
          if (practiceCelebrationRunRef.current !== celebrationRun) return;
          playBogoVictorySound();
        })
        .catch(() => undefined);
    }

    if (!prefersReducedMotion) {
      practiceCelebrationFadeTimerRef.current = window.setTimeout(() => {
        practiceCelebrationFadeTimerRef.current = null;
        if (practiceCelebrationRunRef.current !== celebrationRun) return;
        setPracticeCelebrationPhase("fading");
      }, PRACTICE_CELEBRATION_VISIBLE_DURATION);
    }

    practiceCelebrationUnmountTimerRef.current = window.setTimeout(
      () => {
        practiceCelebrationUnmountTimerRef.current = null;
        if (practiceCelebrationRunRef.current !== celebrationRun) return;
        setPracticeCelebrationPhase("hidden");
      },
      PRACTICE_CELEBRATION_VISIBLE_DURATION +
        (prefersReducedMotion ? 0 : PRACTICE_CELEBRATION_FADE_DURATION),
    );
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

  function completePracticeWalkthrough(
    completionFeedback = "Fully sorted—this completes the walkthrough.",
    options: { playVictorySound?: boolean } = {},
  ) {
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
    insertionKeyPointerRef.current = null;
    setInsertionKeyHeld(false);
    setInsertionKeySelected(false);
    practiceDropTargetRef.current = null;
    setPracticeSolved(true);
    setPracticeFeedback(completionFeedback);
    startPracticeCelebration(options);
  }

  function beginBogoPracticeCasino() {
    if (!isBogoPractice || bogoPracticeBusy) return;

    resetPractice("bogo");
    const casinoActionRun = beginBogoPracticeCasinoAction();
    setBogoPracticeEntered(true);
    setBogoPracticeBusy(true);
    setPracticeFeedback("Welcome to the casino. The table opens as soon as the intro finishes.");
    playBogoPracticeCasinoSound("entry", () => {
      if (bogoPracticeCasinoActionRef.current !== casinoActionRun) return;
      setBogoPracticeBusy(false);
      setPracticeFeedback("The table is open. Gamble to shuffle all four blocks.");
    }, undefined, casinoActionRun);
  }

  function handleBogoPracticeGamble() {
    if (!isBogoPractice || !bogoPracticeEntered || practiceFinished || bogoPracticeBusy) return;

    const casinoActionRun = beginBogoPracticeCasinoAction();
    const finalValues = shufflePracticeValues(practiceValues);
    const nextAttempts = bogoPracticeAttempts + 1;
    const won = isPracticeRowFinished(finalValues, BOGO_PRACTICE_INITIAL_VALUES);
    const rollRun = bogoPracticeRollRunRef.current + 1;

    clearBogoPracticeRoll();
    bogoPracticeRollRunRef.current = rollRun;
    setBogoPracticeBusy(true);
    setBogoPracticeAttempts(nextAttempts);
    setPracticeFeedback("The casino is dealing the next shuffle…");

    const rollValues = () => {
      if (
        bogoPracticeCasinoActionRef.current !== casinoActionRun ||
        bogoPracticeRollRunRef.current !== rollRun
      ) {
        return;
      }
      // Keep the four physical slots in place while their faces rapidly roll
      // through fresh permutations. The real result is held until the clip
      // finishes, so the final order has a clear landing moment.
      setPracticeValues(shufflePracticeValues(BOGO_PRACTICE_INITIAL_VALUES));
    };

    playBogoPracticeCasinoSound("shuffle", () => {
      if (
        bogoPracticeCasinoActionRef.current !== casinoActionRun ||
        bogoPracticeRollRunRef.current !== rollRun
      ) {
        return;
      }
      clearBogoPracticeRoll();
      setPracticeValues(finalValues);

      if (won) {
        completePracticeWalkthrough(
          "Lucky! Gamble " + String(nextAttempts) + " landed on the one sorted order.",
          { playVictorySound: false },
        );
        playBogoPracticeCasinoSound("success", () => {
          if (bogoPracticeCasinoActionRef.current !== casinoActionRun) return;
          setBogoPracticeBusy(false);
        }, undefined, casinoActionRun);
        return;
      }

      setPracticeSolved(false);
      setPracticeFeedback(
        "Gamble " + String(nextAttempts) + " was not sorted. One order out of 24 wins—try again.",
      );
      // The cards have already landed, so a failed gamble should not make the
      // learner wait through its whole sting before trying again. A following
      // gamble clears this one-shot player before it starts the next shuffle.
      setBogoPracticeBusy(false);
      playBogoPracticeCasinoSound("fail", () => undefined, undefined, casinoActionRun);
    }, () => {
      if (
        bogoPracticeCasinoActionRef.current !== casinoActionRun ||
        bogoPracticeRollRunRef.current !== rollRun
      ) {
        return;
      }
      setBogoPracticeRolling(true);
      setPracticeFeedback("Shuffling every possible order…");
      rollValues();
      bogoPracticeRollIntervalRef.current = window.setInterval(
        rollValues,
        BOGO_PRACTICE_ROLL_INTERVAL,
      );
    }, casinoActionRun);
  }

  function resetPractice(nextAlgorithm = algorithm) {
    clearPracticeUndo();
    clearPracticeAdvance();
    clearPracticeClickSuppression();
    clearPracticeCelebration();
    clearBogoPracticeInteraction();
    practiceCompletionRef.current = false;
    const firstStep = normalizePracticeSteps(ALGORITHM_DETAILS[nextAlgorithm].practice)[0];
    const isResettingBogoPractice = nextAlgorithm === "bogo";
    setPracticeStepIndex(0);
    setPracticeSelectedIndex(null);
    setPracticeDragIndex(null);
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropIndex(null);
    setPracticeDropMode(null);
    practicePointerRef.current = null;
    insertionKeyPointerRef.current = null;
    setInsertionKeyHeld(nextAlgorithm === "insertion");
    setInsertionKeySelected(false);
    practiceDropTargetRef.current = null;
    setPracticeSolved(false);
    setBogoPracticeEntered(false);
    setBogoPracticeAttempts(0);
    setPracticeFeedback(null);
    setPracticeValues(
      isResettingBogoPractice
        ? [...BOGO_PRACTICE_INITIAL_VALUES]
        : [...firstStep.start],
    );
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
    // The insertion walkthrough prepares the one correct gap by shifting its
    // larger prefix values automatically. Generic swaps and row inserts are
    // never part of that lesson; only the held yellow key may fill the gap.
    if (isInsertionPractice) {
      setPracticeSolved(false);
      setPracticeFeedback(
        "The larger values have already shifted right. Pick up the held yellow key and place it in the glowing gap. Hint: " +
          currentPractice.hint,
      );
      return "wrong";
    }

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
      if (practiceStepIndex >= practiceSteps.length - 1) {
        setPracticeFeedback("Correct—this completes the walkthrough.");
        return "complete";
      }
      setPracticeFeedback(
        "Correct. Your move follows the rule; the next step is loading.",
      );
      return "solved";
    }

    // Quick Sort's lesson is deliberately one safe partition move at a time.
    // Letting a merely "closer" swap remain can strand the pivot between
    // values with no legal next move, which is both confusing and unlike the
    // intended partition sequence.
    if (isQuickPractice || currentPractice.validation === "exact") {
      setPracticeSolved(false);
      setPracticeFeedback("That does not complete this step's move, so it will slide back. Hint: " + currentPractice.hint);
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

  function placePreparedInsertionKey() {
    if (
      !isPreparedInsertionPractice ||
      insertionKey === null ||
      !isPreparedInsertionKeyPlacement(
        practiceValues,
        currentPractice.target,
        insertionKey,
        currentPractice.target,
      )
    ) {
      setPracticeFeedback(
        "That key needs the prepared glowing gap. Hint: " + currentPractice.hint,
      );
      return;
    }

    practiceBlockPositionsRef.current = capturePracticeBlockPositions();
    const nextValues = [...currentPractice.target];
    setPracticeValues(nextValues);
    setInsertionKeyHeld(false);
    setInsertionKeySelected(false);
    setPracticeSolved(true);

    if (
      practiceStepIndex >= practiceSteps.length - 1 ||
      isPracticeRowFinished(nextValues, currentPractice.target)
    ) {
      completePracticeWalkthrough();
      return;
    }

    setPracticeFeedback("Correct. The key filled its gap; the next key is loading.");
    schedulePracticeAdvance();
  }

  function getPreparedInsertionGapTarget(
    clientX: number,
    clientY: number,
  ): PracticeDropTarget | null {
    const board = practiceBoardRef.current;
    const gapIndex = preparedInsertionKeyDrop?.gapIndex;
    const gap = board?.querySelector<HTMLElement>("[data-practice-insertion-gap]");
    if (!board || gapIndex === undefined || !gap) return null;

    const boardRect = board.getBoundingClientRect();
    if (
      clientX < boardRect.left ||
      clientX > boardRect.right ||
      clientY < boardRect.top ||
      clientY > boardRect.bottom
    ) {
      return null;
    }

    const region = getPracticeDropRegion(gap, gapIndex, PRACTICE_DIRECT_DROP_HIT_SLOP);
    return clientX >= region.left &&
      clientX <= region.right &&
      clientY >= region.top &&
      clientY <= region.bottom
        ? { index: gapIndex, mode: "insert" }
        : null;
  }

  function clearPreparedInsertionKeyDrag() {
    insertionKeyPointerRef.current = null;
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropTarget(null);
  }

  function handlePreparedInsertionKeyPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (
      !isPreparedInsertionPractice ||
      practiceFinished ||
      practiceUndoPending ||
      event.button !== 0
    ) {
      return;
    }

    event.currentTarget.getAnimations().forEach((animation) => animation.cancel());
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    insertionKeyPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      anchorX: event.clientX - (bounds.left + bounds.width / 2),
      anchorY: event.clientY - (bounds.top + bounds.height / 2),
      moved: false,
    };
    setPracticeDraggingId(null);
    setPracticeDragOffset({ x: 0, y: 0 });
    setPracticeDropTarget(null);
  }

  function handlePreparedInsertionKeyPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = insertionKeyPointerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) > 5 && !drag.moved) {
      drag.moved = true;
      setPracticeDraggingId("insertion-key");
    }
    if (!drag.moved) return;

    event.preventDefault();
    setPracticeDragOffset({ x: deltaX + drag.anchorX, y: deltaY + drag.anchorY });
    setPracticeDropTarget(getPreparedInsertionGapTarget(event.clientX, event.clientY));
  }

  function finishPreparedInsertionKeyDrag(
    event?: ReactPointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) {
    const drag = insertionKeyPointerRef.current;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;

    const target =
      !cancelled && event
        ? getPreparedInsertionGapTarget(event.clientX, event.clientY)
        : null;
    if (drag.moved) suppressPracticeClickAfterDrag();
    clearPreparedInsertionKeyDrag();
    if (target) placePreparedInsertionKey();
  }

  function handlePreparedInsertionKeyClick() {
    if (!isPreparedInsertionPractice || practiceFinished || practiceUndoPending) return;
    if (suppressPracticeClickRef.current) {
      suppressPracticeClickRef.current = false;
      return;
    }

    setInsertionKeySelected((selected) => {
      setPracticeFeedback(
        selected
          ? "The key is back in hand. Pick it up when you are ready to place it."
          : "Key picked up. Drop it into the one glowing gap.",
      );
      return !selected;
    });
  }

  function handlePreparedInsertionGapClick() {
    if (!isPreparedInsertionPractice || practiceFinished || practiceUndoPending) return;
    if (!insertionKeySelected) {
      setPracticeFeedback("Pick up the yellow key first, then place it in this glowing gap.");
      return;
    }
    placePreparedInsertionKey();
  }

  function handlePracticeBlockClick(index: number) {
    if (practiceFinished || practiceUndoPending) return;
    if (isPreparedInsertionPractice) {
      setPracticeFeedback(
        "The row is ready. Pick up the held yellow key and place it in the one glowing gap.",
      );
      return;
    }
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

    // A block that just changed places is still allowed to finish its brief
    // FLIP placement animation. If the learner grabs it during that window,
    // the Web Animations transform would otherwise take precedence over the
    // drag's inline transform. Cancel it before measuring the pickup point so
    // every value—including Bubble's newly placed 1—can be picked up at once.
    event.currentTarget.getAnimations().forEach((animation) => animation.cancel());
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
      // A final scheduled step used to bypass the common completion handler,
      // leaving the last lesson without its fixed-green finish or payoff.
      completePracticeWalkthrough();
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
    insertionKeyPointerRef.current = null;
    setInsertionKeyHeld(nextStep.insertingKey !== undefined);
    setInsertionKeySelected(false);
    practiceDropTargetRef.current = null;
    setPracticeSolved(false);
    setPracticeFeedback(null);
    setPracticeValues([...nextStep.start]);
  }

  function focusAlgorithmPickerOption(nextOption: AlgorithmId) {
    window.requestAnimationFrame(() => {
      algorithmPickerItemRefs.current.get(nextOption)?.focus();
    });
  }

  function closeAlgorithmPicker(restoreTriggerFocus = false) {
    setIsAlgorithmPickerOpen(false);
    if (restoreTriggerFocus) {
      window.requestAnimationFrame(() => algorithmPickerTriggerRef.current?.focus());
    }
  }

  function openAlgorithmPicker(focusPosition: "first" | "last" = "first") {
    if (isRunning) return;
    setIsAlgorithmPickerOpen(true);
    const nextOption =
      focusPosition === "first"
        ? algorithmPickerOptions[0]
        : algorithmPickerOptions[algorithmPickerOptions.length - 1];
    if (nextOption) focusAlgorithmPickerOption(nextOption);
  }

  function handleAlgorithmPickerTriggerClick() {
    if (isAlgorithmPickerOpen) {
      closeAlgorithmPicker();
      return;
    }
    openAlgorithmPicker();
  }

  function handleAlgorithmPickerTriggerKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAlgorithmPicker("first");
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      openAlgorithmPicker("last");
      return;
    }
    if (event.key === "Escape" && isAlgorithmPickerOpen) {
      event.preventDefault();
      closeAlgorithmPicker();
    }
  }

  function handleAlgorithmPickerMenuKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    optionIndex: number,
  ) {
    const optionCount = algorithmPickerOptions.length;
    if (optionCount === 0) return;

    const focusOptionAt = (nextIndex: number) => {
      const normalizedIndex = (nextIndex + optionCount) % optionCount;
      const nextOption = algorithmPickerOptions[normalizedIndex];
      if (nextOption) focusAlgorithmPickerOption(nextOption);
    };

    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        focusOptionAt(optionIndex + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        focusOptionAt(optionIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        focusOptionAt(0);
        break;
      case "End":
        event.preventDefault();
        focusOptionAt(optionCount - 1);
        break;
      case "Escape":
        event.preventDefault();
        closeAlgorithmPicker(true);
        break;
      case "Tab":
        setIsAlgorithmPickerOpen(false);
        break;
      default:
        break;
    }
  }

  function handleAlgorithmCardTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: AlgorithmCardTab,
  ) {
    let nextTab: AlgorithmCardTab | null = null;

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextTab = currentTab === "walkthrough" ? "python" : "walkthrough";
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextTab = currentTab === "walkthrough" ? "python" : "walkthrough";
    } else if (event.key === "Home") {
      nextTab = "walkthrough";
    } else if (event.key === "End") {
      nextTab = "python";
    }

    if (!nextTab) return;

    event.preventDefault();
    setAlgorithmCardTab(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(algorithm + "-" + nextTab + "-tab")?.focus();
    });
  }

  function setAlgorithmPickerItemRef(
    option: AlgorithmId,
    element: HTMLButtonElement | null,
  ) {
    if (element) {
      algorithmPickerItemRefs.current.set(option, element);
      return;
    }
    algorithmPickerItemRefs.current.delete(option);
  }

  function selectAlgorithmFromPicker(nextAlgorithm: AlgorithmId) {
    if (isRunning) return;
    handleAlgorithmChange(nextAlgorithm);
  }

  function handleAlgorithmCycle(direction: -1 | 1) {
    if (isRunning) return;
    selectAlgorithmFromPicker(direction === -1 ? previousAlgorithm : nextAlgorithm);
  }

  function handleAlgorithmChange(nextAlgorithm: AlgorithmId) {
    setIsAlgorithmPickerOpen(false);
    setAlgorithmCardTab("walkthrough");
    resetCompletionSweep();
    resetBogoElapsedTimer();
    setBogoUnlimitedConfirmation(false);
    setBogoCelebrationPhase("hidden");
    cancelActiveBogoWorkerRun();
    bogoSessionRef.current = null;
    bogoRateSampleRef.current = null;
    setBogoLiveStep(null);
    setBogoMeasuredShuffleRate(null);
    const nextMaximumArraySize =
      nextAlgorithm === "bogo" ? BOGO_MAX_ARRAY_SIZE : 256;
    const nextArraySize = Math.min(arraySize, nextMaximumArraySize);
    const nextValues =
      nextArraySize === arraySize
        ? [...originalValues]
        : makeArrayForArrangement(nextArraySize, arrayArrangement);
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
    // An unlimited-run confirmation is setup UI, not an implicit instruction
    // to begin searching. Ignore a queued click as well as disabling the
    // visible button below so this is safe across desktop WebViews.
    if (isBogo && (bogoUnlimitedConfirmationOpen || bogoUnlimitedConfirmationRef.current)) return;

    if (!startWithNewArray && runState === "running") {
      if (isBogo) {
        const activeRun = activeBogoWorkerRunRef.current;
        if (activeRun) {
          bogoWorkerRef.current?.postMessage({ type: "pause", runId: activeRun.runId });
        }
      }
      setRunState("paused");
      return;
    }

    if (!startWithNewArray && runState === "paused") {
      if (soundEnabled) activateAudioOutput();
      if (isBogo && bogoSessionRef.current) {
        bogoRateSampleRef.current = {
          startedAt: performance.now(),
          startingAttempts: bogoSessionRef.current.attempts,
          lastReportedAt: 0,
        };
        setBogoMeasuredShuffleRate(null);
        const activeRun = activeBogoWorkerRunRef.current;
        if (activeRun) {
          bogoWorkerRef.current?.postMessage({ type: "resume", runId: activeRun.runId });
        }
      }
      setRunState("running");
      return;
    }

    // Finishing a run turns the primary action into a quick way to see the
    // selected algorithm on a genuinely new permutation, rather than replaying
    // the exact same input. While the board is merely ready, preserve its
    // current values so the initial and freshly resized examples can be sorted.
    const sortValues = startWithNewArray || runState === "complete"
      ? makeArrayForArrangement(arraySize, arrayArrangement)
      : originalValues;
    if (startWithNewArray || runState === "complete") {
      setOriginalValues(sortValues);
    }

    const audioContext = soundEnabled ? activateAudioOutput() : null;
    resetCompletionSweep();
    resetBogoElapsedTimer();
    setBogoCelebrationPhase("hidden");
    if (algorithm === "bogo") {
      if (audioContext) {
        // Start one texture in the click gesture. Fast Bogo batches can finish
        // before the normal interval has time to produce an audible note.
        void audioContext.resume().then(() => playBogoShuffleTexture(0)).catch(() => undefined);
      }
      beginBogoWorkerRun();
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
      if (!session.done) getOrCreateBogoWorker();
      setRunState(session.done ? "complete" : "running");
      return;
    }

    cancelActiveBogoWorkerRun();
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
    if (isBogoConfigurationLocked || hasActiveBogoSessionNow()) return;

    const clampedSize = Math.min(maximumArraySize, Math.max(minimumArraySize, Math.round(nextSize)));
    if (clampedSize === arraySize) {
      setArraySizeInput(String(clampedSize));
      return;
    }
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

  const beginSpeedVisualAdjustment = useCallback(() => {
    // Bogo does not use the move interpolation path, so there is nothing to
    // freeze there. For every other algorithm, retain the current visual mode
    // until the person finishes changing the control.
    if (isBogo) return;
    setSettledVisualSpeed(speedRef.current);
    setIsAdjustingSpeedControl(true);
  }, [isBogo]);

  const finishSpeedVisualAdjustment = useCallback(() => {
    if (isBogo) return;
    // Commit the exact locally painted Canvas frame before changing the
    // renderer predicate. React batches this state update with the speed
    // release, so a Canvas-to-DOM handoff cannot briefly show the stale
    // semantic checkpoint from before the drag.
    if (
      useCanvasBarRenderer &&
      denseCanvasPlaybackTraceRef.current === steps
    ) {
      const latestCanvasStepIndex = denseCanvasPlaybackStepIndexRef.current;
      setStepIndex((current) =>
        current === latestCanvasStepIndex ? current : latestCanvasStepIndex,
      );
    }
    // `speedRef` is updated synchronously by handleSpeedChange, which also
    // covers a final native range input that arrives just before pointer-up.
    setSettledVisualSpeed(speedRef.current);
    setIsAdjustingSpeedControl(false);
  }, [isBogo, steps, useCanvasBarRenderer]);

  const beginSpeedRangePointerInteraction = useCallback((pointerId: number) => {
    speedRangePointerIdRef.current = pointerId;
    beginSpeedVisualAdjustment();
  }, [beginSpeedVisualAdjustment]);

  const finishSpeedRangePointerInteraction = useCallback((pointerId?: number) => {
    const activePointerId = speedRangePointerIdRef.current;
    if (
      pointerId !== undefined &&
      activePointerId !== null &&
      activePointerId !== pointerId
    ) {
      return;
    }

    speedRangePointerIdRef.current = null;
    if (speedAdjustmentKeysRef.current.size === 0) {
      finishSpeedVisualAdjustment();
    }
  }, [finishSpeedVisualAdjustment]);

  // Some Linux WebKit builds can lose an input range's pointer-up while the
  // native thumb is being dragged. Do not capture the pointer ourselves—the
  // native control already does that—but listen at the window boundary as a
  // cleanup fallback for mouse, touch, pen, cancelled gestures, and a window
  // focus/visibility change.
  useEffect(() => {
    if (!isAdjustingSpeedControl) return;

    const finishOnPointerEnd = (event: PointerEvent) => {
      if (speedRangePointerIdRef.current === null) return;
      finishSpeedRangePointerInteraction(event.pointerId);
    };
    const finishOnWindowLoss = () => {
      speedAdjustmentKeysRef.current.clear();
      finishSpeedRangePointerInteraction();
    };
    const finishOnVisibilityChange = () => {
      if (document.visibilityState !== "visible") finishOnWindowLoss();
    };

    window.addEventListener("pointerup", finishOnPointerEnd, true);
    window.addEventListener("pointercancel", finishOnPointerEnd, true);
    window.addEventListener("blur", finishOnWindowLoss);
    document.addEventListener("visibilitychange", finishOnVisibilityChange);
    return () => {
      window.removeEventListener("pointerup", finishOnPointerEnd, true);
      window.removeEventListener("pointercancel", finishOnPointerEnd, true);
      window.removeEventListener("blur", finishOnWindowLoss);
      document.removeEventListener("visibilitychange", finishOnVisibilityChange);
    };
  }, [finishSpeedRangePointerInteraction, isAdjustingSpeedControl]);

  function isSpeedAdjustmentKey(key: string) {
    return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(key);
  }

  function beginSpeedKeyboardInteraction(key: string) {
    if (!isSpeedAdjustmentKey(key)) return;
    const wasAdjustingWithKeyboard = speedAdjustmentKeysRef.current.size > 0;
    speedAdjustmentKeysRef.current.add(key);
    // Auto-repeat delivers additional key-down events while the key remains
    // held. Capture the visual threshold only on the first one; otherwise a
    // fast value change could quietly replace the frozen renderer policy.
    if (!wasAdjustingWithKeyboard && speedRangePointerIdRef.current === null) {
      beginSpeedVisualAdjustment();
    }
  }

  function finishSpeedKeyboardInteraction(key: string) {
    if (!isSpeedAdjustmentKey(key)) return;
    speedAdjustmentKeysRef.current.delete(key);
    if (speedAdjustmentKeysRef.current.size === 0 && speedRangePointerIdRef.current === null) {
      finishSpeedVisualAdjustment();
    }
  }

  function finishAllSpeedVisualAdjustments() {
    speedRangePointerIdRef.current = null;
    speedAdjustmentKeysRef.current.clear();
    finishSpeedVisualAdjustment();
  }

  function handleSpeedChange(nextSpeed: number) {
    const clampedSpeed = Math.min(maximumSpeed, Math.max(1, Math.round(nextSpeed)));
    if (isBogo && clampedSpeed !== speed) {
      const session = bogoSessionRef.current;
      const modeledShuffleRate = getBogoEstimatedShuffleRate(clampedSpeed);
      const activeWorkerRun = activeBogoWorkerRunRef.current;
      const canUseWorkerConfigurationSnapshot =
        session !== null &&
        !session.done &&
        activeWorkerRun !== null &&
        bogoWorkerRef.current !== null &&
        !bogoWorkerUnavailable;

      if (canUseWorkerConfigurationSnapshot) {
        const configurationId = bogoWorkerConfigurationIdRef.current + 1;
        bogoWorkerConfigurationIdRef.current = configurationId;
        pendingBogoWorkerRateCalibrationRef.current = {
          runId: activeWorkerRun.runId,
          configurationId,
          modeledShuffleRate,
        };
        // Wait for the worker to acknowledge the new pacing from its exact
        // mutable session. The last UI snapshot can trail a fast worker by
        // tens of thousands of attempts and must not seed the new rate.
        bogoRateSampleRef.current = null;
        bogoExpectedRateSampleRef.current = null;
        setBogoMeasuredShuffleRate(null);
        setBogoFrozenExpectedShuffleRate(null);
        setBogoExpectedRateSource("calibrating");
      } else {
        pendingBogoWorkerRateCalibrationRef.current = null;
        bogoRateSampleRef.current =
          session && runState === "running"
            ? {
                startedAt: performance.now(),
                startingAttempts: session.attempts,
                lastReportedAt: 0,
              }
            : null;
        restartBogoExpectedRateCalibration(session, modeledShuffleRate);
      }
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
    if (isBogoConfigurationLocked || hasActiveBogoSessionNow()) return;

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
    if (isBogoSessionLocked || hasActiveBogoSessionNow()) return;

    if (!checked) {
      if (!bogoRunsUntilSolved) return;
      setBogoRunsUntilSolved(false);
      // Changing the cap is a setup action, never a request to keep running
      // the previous session. Clear the session synchronously through the
      // regular reset path so no queued Bogo batch can continue.
      resetArray();
      return;
    }

    if (bogoRunsUntilSolved || bogoUnlimitedConfirmationRef.current) return;
    // Native `window.confirm` is suppressed by some desktop WebViews. Keep
    // this confirmation in the app so Windows, Linux, and macOS all expose
    // the same deliberate setup-only decision.
    setBogoUnlimitedConfirmation(true);
  }

  function confirmBogoRunsUntilSolved() {
    if (
      !bogoUnlimitedConfirmationRef.current ||
      isBogoSessionLocked ||
      hasActiveBogoSessionNow()
    ) {
      return;
    }

    setBogoRunsUntilSolved(true);
    // This is only a configuration change for the *next* Start sorting click.
    // Resetting also clears any stale session references before the checkbox
    // can affect a future run.
    resetArray();
  }

  function cancelBogoRunsUntilSolvedConfirmation() {
    setBogoUnlimitedConfirmation(false);
  }

  function handleWorkloadBarAlgorithmVisibilityToggle(nextAlgorithm: BenchmarkAlgorithm) {
    const nextTransitionId = workloadBarTransitionRunRef.current + 1;
    workloadBarTransitionRunRef.current = nextTransitionId;

    setVisibleWorkloadBarAlgorithms((current) => ({
      ...current,
      [nextAlgorithm]: !current[nextAlgorithm],
    }));

    if (visibleWorkloadBarAlgorithms[nextAlgorithm]) {
      setEnteringWorkloadBarAlgorithms((current) => {
        if (current[nextAlgorithm] === undefined) return current;
        const next = { ...current };
        delete next[nextAlgorithm];
        return next;
      });
      setExitingWorkloadBarAlgorithms((current) => ({
        ...current,
        [nextAlgorithm]: nextTransitionId,
      }));
      return;
    }

    setExitingWorkloadBarAlgorithms((current) => {
      if (current[nextAlgorithm] === undefined) return current;
      const next = { ...current };
      delete next[nextAlgorithm];
      return next;
    });
    setEnteringWorkloadBarAlgorithms((current) => ({
      ...current,
      [nextAlgorithm]: nextTransitionId,
    }));
  }

  function handleWorkloadBarRowAnimationEnd(
    nextAlgorithm: BenchmarkAlgorithm,
    transitionId: number,
    phase: "entering" | "exiting",
  ) {
    if (phase === "exiting") {
      setExitingWorkloadBarAlgorithms((current) => {
        if (current[nextAlgorithm] !== transitionId) return current;
        const next = { ...current };
        delete next[nextAlgorithm];
        return next;
      });
      return;
    }

    setEnteringWorkloadBarAlgorithms((current) => {
      if (current[nextAlgorithm] !== transitionId) return current;
      const next = { ...current };
      delete next[nextAlgorithm];
      return next;
    });
  }

  function setIntroPhaseImmediately(nextPhase: IntroPhase) {
    introPhaseRef.current = nextPhase;
    setIntroPhase(nextPhase);
  }

  function clearIntroDismissTimer() {
    if (introDismissTimerRef.current === null) return;
    window.clearTimeout(introDismissTimerRef.current);
    introDismissTimerRef.current = null;
  }

  function resetViewportForIntro() {
    // The former logo anchor navigated to #visualizer, which could leave an
    // in-page scroll target behind after the welcome overlay was reopened.
    // Replace the hash rather than assigning location so no extra history
    // entry or native anchor jump is introduced.
    if (window.location.hash) {
      try {
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search,
        );
      } catch {
        // A restrictive embedded browser can reject history writes. The
        // viewport reset below still returns the person to the true top.
      }
    }

    // `html` normally has smooth scrolling enabled. Override it for this one
    // reset so closing the welcome screen cannot reveal an in-flight scroll.
    const root = document.documentElement;
    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    root.style.scrollBehavior = previousScrollBehavior;
    // These fallbacks cover browsers that keep the scrolling element on body
    // rather than documentElement.
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function reopenIntro(returnFocusTarget: HTMLElement | null) {
    clearIntroDismissTimer();
    introReturnFocusRef.current = returnFocusTarget ?? brandButtonRef.current;
    setIsAlgorithmPickerOpen(false);
    resetViewportForIntro();
    setIntroPhaseImmediately("visible");
  }

  function dismissIntro() {
    if (introPhaseRef.current !== "visible") return;

    // The welcome screen is commonly the first click in the app. Prime audio
    // right here as well as in the global gesture listener so an exceptionally
    // fast first click can still unlock WKWebView before later sorting sounds.
    if (soundVolumeRef.current > 0) {
      try {
        activateAudioOutput();
      } catch {
        // The intro remains usable when a host has no output device.
      }
    }

    // A fresh click through the first-run screen has no opener to restore.
    // Return to the logo in that case rather than leaving focus on a node that
    // will disappear when the overlay unmounts.
    introReturnFocusRef.current ??= brandButtonRef.current;

    try {
      window.sessionStorage.setItem(SORTSCOPE_INTRO_SESSION_KEY, "seen");
    } catch {
      // The interaction remains usable even when session storage is blocked.
    }

    const reduceMotionNow =
      prefersReducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotionNow) {
      setIntroPhaseImmediately("hidden");
      return;
    }

    setIntroPhaseImmediately("exiting");
    introDismissTimerRef.current = window.setTimeout(() => {
      introDismissTimerRef.current = null;
      if (introPhaseRef.current !== "exiting") return;
      setIntroPhaseImmediately("hidden");
    }, SORTSCOPE_INTRO_EXIT_DURATION);
  }

  function handleIntroKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      // The dialog has one click-anywhere action rather than internal form
      // controls, so keep Tab from falling through to page controls behind it.
      event.preventDefault();
      introOverlayRef.current?.focus();
      return;
    }

    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar" || event.key === "Escape") {
      event.preventDefault();
      dismissIntro();
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
      {introPhase !== "hidden" && (
        // The welcome dialog deliberately makes its complete surface one
        // keyboard-operable dismiss target rather than placing a separate
        // button over the explanatory content.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Full-surface dialog dismissal is an intentional interaction.
        <div
          ref={introOverlayRef}
          className={
            "sortscope-intro " +
            (introPhase === "exiting" ? "sortscope-intro--exiting" : "")
          }
          role="dialog"
          aria-modal="true"
          aria-labelledby="sortscope-intro-title"
          aria-describedby="sortscope-intro-description sortscope-intro-invitation"
          tabIndex={-1}
          onClick={dismissIntro}
          onKeyDown={handleIntroKeyDown}
        >
          <div className="sortscope-intro__content">
            <span className="brand-mark sortscope-intro__mark" aria-hidden="true" />
            <p className="sortscope-intro__eyebrow">SORTING, MADE VISIBLE</p>
            <h1 id="sortscope-intro-title">Sortscope</h1>
            <p id="sortscope-intro-description" className="sortscope-intro__description">
              A hands on deep dive into the world of sorting algorithms.
            </p>
            <p id="sortscope-intro-invitation" className="sortscope-intro__invitation">
              <span>Click or tap anywhere to enter</span>
              <small>Press Enter or Space</small>
            </p>
          </div>
        </div>
      )}
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
      {practiceCelebrationPhase !== "hidden" && (
        <div
          className={
            "practice-celebration " +
            (practiceCelebrationPhase === "fading" ? "practice-celebration--fading " : "") +
            (prefersReducedMotion ? "practice-celebration--reduced" : "")
          }
          role="status"
          aria-live="polite"
        >
          <span className="sr-only">Lesson complete.</span>
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
        </div>
      )}

      <div className="shell">
        <header className="site-header">
          <button
            ref={brandButtonRef}
            className="brand"
            type="button"
            onClick={(event) => reopenIntro(event.currentTarget)}
            aria-label="Return to the Sortscope welcome screen"
          >
            <span className="brand-mark" aria-hidden="true" />
            <span>sortscope</span>
          </button>
          <div className="header-note">
            <span className="header-note__dot" aria-hidden="true" />
            algorithm study tool
          </div>
        </header>

        <section className="hero" aria-labelledby="page-title">
          <div>
            <div className="hero__algorithm-picker" ref={algorithmPickerRef}>
              <button
                className="hero__algorithm-cycle hero__algorithm-cycle--previous"
                type="button"
                onClick={() => handleAlgorithmCycle(-1)}
                disabled={isRunning}
                aria-label={"Previous algorithm: " + ALGORITHM_DETAILS[previousAlgorithm].label}
              >
                <span aria-hidden="true" />
              </button>
              <div className="hero__algorithm-picker-title">
                <p className="hero__algorithm-picker-label">CURRENT ALGORITHM</p>
                <h1 id="page-title" className="hero__algorithm-title">
                  <span className="hero__algorithm-title-sizers" aria-hidden="true">
                    {ALGORITHM_ORDER.map((option) => (
                      <span key={option}>{ALGORITHM_DETAILS[option].label}</span>
                    ))}
                  </span>
                  <button
                    ref={algorithmPickerTriggerRef}
                    className="hero__algorithm-trigger"
                    type="button"
                    onClick={handleAlgorithmPickerTriggerClick}
                    onKeyDown={handleAlgorithmPickerTriggerKeyDown}
                    disabled={isRunning}
                    aria-haspopup="menu"
                    aria-expanded={isAlgorithmPickerOpen}
                    aria-controls="algorithm-picker-menu"
                    aria-label={"Choose sorting algorithm. Current algorithm: " + algorithmLabel}
                  >
                    {algorithmLabel}
                  </button>
                </h1>
              </div>
              <button
                className="hero__algorithm-cycle hero__algorithm-cycle--next"
                type="button"
                onClick={() => handleAlgorithmCycle(1)}
                disabled={isRunning}
                aria-label={"Next algorithm: " + ALGORITHM_DETAILS[nextAlgorithm].label}
              >
                <span aria-hidden="true" />
              </button>

              {isAlgorithmPickerOpen && (
                <div
                  id="algorithm-picker-menu"
                  className="hero__algorithm-menu"
                  role="menu"
                  aria-label="Other sorting algorithms"
                >
                  {algorithmPickerOptions.map((option, optionIndex) => (
                    <button
                      ref={(element) => setAlgorithmPickerItemRef(option, element)}
                      className="hero__algorithm-option"
                      key={option}
                      type="button"
                      role="menuitem"
                      onClick={() => selectAlgorithmFromPicker(option)}
                      onKeyDown={(event) =>
                        handleAlgorithmPickerMenuKeyDown(event, optionIndex)
                      }
                    >
                      <span>{ALGORITHM_DETAILS[option].number}</span>
                      <strong>{ALGORITHM_DETAILS[option].label}</strong>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="hero-copy">{algorithmDetails.heroCopy}</p>
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
              {isBogo && (
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
              )}

              {!isBogo && (
                <label className="control-field control-field--arrangement">
                  <span className="control-label">Starting arrangement</span>
                  <select
                    value={arrayArrangement}
                    onChange={(event) =>
                      handleArrayArrangementChange(event.target.value as ArrayArrangement)
                    }
                    disabled={isRunning}
                    aria-label="Starting array arrangement"
                  >
                    <option value="random">Random shuffle</option>
                    <option value="nearly-sorted">Nearly sorted</option>
                    <option value="reverse">Reverse order</option>
                  </select>
                </label>
              )}

              {isBogo && (
                <>
                    <div className="control-field control-field--range bogo-attempt-limit">
                      <span className="control-label">
                      Max shuffles (up to 999,999,999)
                        <span className="control-number-stepper control-number-stepper--bogo">
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
                          disabled={isBogoConfigurationLocked || bogoRunsUntilSolved}
                          aria-label="Maximum Bogo Sort shuffles exact value"
                        />
                          <span className="control-number-stepper__buttons">
                            <button
                              className="control-number-stepper__button control-number-stepper__button--up"
                              type="button"
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={() => handleBogoAttemptLimitChange(bogoAttemptLimit + bogoSliderStep)}
                              disabled={isBogoConfigurationLocked || bogoRunsUntilSolved || bogoAttemptLimit >= bogoAttemptMaximum}
                              aria-label="Increase maximum Bogo Sort shuffles"
                            >
                              <span aria-hidden="true" />
                            </button>
                            <button
                              className="control-number-stepper__button control-number-stepper__button--down"
                              type="button"
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={() => handleBogoAttemptLimitChange(bogoAttemptLimit - bogoSliderStep)}
                              disabled={isBogoConfigurationLocked || bogoRunsUntilSolved || bogoAttemptLimit <= BOGO_MIN_ATTEMPTS}
                              aria-label="Decrease maximum Bogo Sort shuffles"
                            >
                              <span aria-hidden="true" />
                            </button>
                          </span>
                        </span>
                      </span>
                      <input
                        type="range"
                        min={BOGO_MIN_ATTEMPTS}
                        max={bogoAttemptMaximum}
                        step={bogoSliderStep}
                        value={bogoAttemptLimit}
                        onChange={(event) => handleBogoAttemptLimitChange(Number(event.target.value))}
                        disabled={isBogoConfigurationLocked || bogoRunsUntilSolved}
                        aria-label="Maximum Bogo Sort shuffles"
                      />
                    </div>
                    <div
                      className={
                        "bogo-unlimited-warning " +
                        (bogoRunsUntilSolved ? "bogo-unlimited-warning--armed " : "") +
                        (isBogoSessionLocked ? "bogo-unlimited-warning--disabled" : "")
                      }
                    >
                      <label
                        className="bogo-unlimited-warning__choice"
                        htmlFor="bogo-runs-until-solved"
                        aria-label="Let Bogo Sort run until solved"
                      >
                        <input
                          id="bogo-runs-until-solved"
                          type="checkbox"
                          checked={bogoRunsUntilSolved}
                          onChange={(event) => handleBogoRunsUntilSolvedChange(event.target.checked)}
                          disabled={isBogoConfigurationLocked}
                          aria-label="Let Bogo Sort run until solved"
                          aria-describedby="bogo-unlimited-warning-note"
                        />
                        <span>
                          <strong>Let it run until solved</strong>
                          <small id="bogo-unlimited-warning-note">
                            Warning: May run until the sun explodes.
                          </small>
                        </span>
                      </label>
                      {bogoUnlimitedConfirmationOpen && (
                        <div
                          className="bogo-unlimited-confirmation"
                          role="group"
                          aria-label="Confirm unlimited Bogo Sort runs"
                        >
                          <p>Remove the shuffle cap for the next run?</p>
                          <div>
                            <button
                              className="bogo-unlimited-confirmation__confirm"
                              type="button"
                              onClick={confirmBogoRunsUntilSolved}
                            >
                              Enable unlimited
                            </button>
                            <button
                              className="bogo-unlimited-confirmation__cancel"
                              type="button"
                              onClick={cancelBogoRunsUntilSolvedConfirmation}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

              <div
                className={
                  "control-field control-field--range control-field--array-size " +
                  (isBogo ? "control-field--array-size-bogo" : "")
                }
              >
                <span className="control-label">
                  <span className="control-label__name">
                    Array size
                    {isBogo && <small>Max {BOGO_MAX_ARRAY_SIZE}</small>}
                  </span>
                  <span className="control-number-stepper">
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
                      disabled={isBogoConfigurationLocked}
                      aria-label="Array size exact value"
                    />
                    <span className="control-number-stepper__buttons">
                      <button
                        className="control-number-stepper__button control-number-stepper__button--up"
                        type="button"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => handleArraySizeChange(arraySize + 1)}
                        disabled={isBogoConfigurationLocked || arraySize >= maximumArraySize}
                        aria-label="Increase array size"
                      >
                        <span aria-hidden="true" />
                      </button>
                      <button
                        className="control-number-stepper__button control-number-stepper__button--down"
                        type="button"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => handleArraySizeChange(arraySize - 1)}
                        disabled={isBogoConfigurationLocked || arraySize <= minimumArraySize}
                        aria-label="Decrease array size"
                      >
                        <span aria-hidden="true" />
                      </button>
                    </span>
                  </span>
                </span>
                <input
                  type="range"
                  min={minimumArraySize}
                  max={maximumArraySize}
                  step="1"
                  value={arraySize}
                  onChange={(event) => handleArraySizeChange(Number(event.target.value))}
                  disabled={isBogoConfigurationLocked}
                  aria-label="Array size"
                />
              </div>

              <div className="control-field control-field--range">
                <span className="control-label">
                  <span className="control-label__name">
                    Speed
                  </span>
                  {prefersReducedMotion ? (
                    <strong>instant</strong>
                  ) : (
                    <span className="control-number-stepper">
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
                      <span className="control-number-stepper__buttons">
                        <button
                          className="control-number-stepper__button control-number-stepper__button--up"
                          type="button"
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => handleSpeedChange(speed + 1)}
                          disabled={speed >= maximumSpeed}
                          aria-label="Increase animation speed"
                        >
                          <span aria-hidden="true" />
                        </button>
                        <button
                          className="control-number-stepper__button control-number-stepper__button--down"
                          type="button"
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => handleSpeedChange(speed - 1)}
                          disabled={speed <= 1}
                          aria-label="Decrease animation speed"
                        >
                          <span aria-hidden="true" />
                        </button>
                      </span>
                    </span>
                  )}
                </span>
                <input
                  type="range"
                  min="1"
                  max={maximumSpeed}
                  value={speed}
                  onChange={(event) => handleSpeedChange(Number(event.target.value))}
                  onPointerDown={(event) => {
                    // Let the native range own its pointer capture. Taking a
                    // second capture here can leave WebKitGTK's thumb stuck
                    // to the cursor after release.
                    if (event.pointerType === "mouse" && event.button !== 0) return;
                    beginSpeedRangePointerInteraction(event.pointerId);
                  }}
                  onPointerUp={(event) => {
                    finishSpeedRangePointerInteraction(event.pointerId);
                  }}
                  onPointerCancel={(event) => finishSpeedRangePointerInteraction(event.pointerId)}
                  onBlur={finishAllSpeedVisualAdjustments}
                  onKeyDown={(event) => {
                    beginSpeedKeyboardInteraction(event.key);
                  }}
                  onKeyUp={(event) => {
                    finishSpeedKeyboardInteraction(event.key);
                  }}
                  aria-label="Animation speed"
                />
              </div>

              <div className={"button-row " + (isBogo ? "button-row--bogo" : "")}>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => handlePrimaryAction()}
                  disabled={isBogo && bogoUnlimitedConfirmationOpen}
                >
                  <span className={"button-pulse " + (runState === "running" ? "button-pulse--active" : "")} aria-hidden="true" />
                  {primaryLabel}
                </button>
                {isBogo ? (
                  <span className="button-row__secondary-slot">
                    {runState === "paused" ? (
                      <button className="button button--secondary button--sort-new-array" type="button" onClick={() => handlePrimaryAction(true)}>
                        Sort new array
                      </button>
                    ) : (
                      <span aria-hidden="true" />
                    )}
                  </span>
                ) : (
                  runState === "paused" && (
                    <button className="button button--secondary button--sort-new-array" type="button" onClick={() => handlePrimaryAction(true)}>
                      Sort new array
                    </button>
                  )
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
                <p className="workbench__message" ref={denseWorkbenchMessageRef}>{currentStep.message}</p>
              </div>
              <div className={"phase-chip phase-chip--" + currentStep.phase} ref={densePhaseChipRef}>
                <span aria-hidden="true" />
                {getPhaseLabel(currentStep.phase)}
              </div>
            </div>

            {algorithm === "insertion" && (
              <div
                ref={denseHeldKeyRef}
                className={
                  "held-key " +
                  (currentStep.key !== null && currentStep.gapIndex !== null
                    ? ""
                    : "held-key--reserved")
                }
                aria-hidden="true"
              >
                <span>stored key</span>
                <strong ref={denseHeldKeyValueRef}>{currentStep.key ?? ""}</strong>
                <em ref={denseHeldKeyDetailRef}>
                  {currentStep.gapIndex === null
                    ? "gap ready for the next key"
                    : "gap at slot " + (currentStep.gapIndex + 1)}
                </em>
              </div>
            )}
            <div className="chart-stage" role="img" aria-label={chartAccessibleLabel}>
              <div className="chart-grid" aria-hidden="true" />
              {useCanvasBarRenderer ? (
                <DenseBarCanvas
                  items={renderedBarItems}
                  largestValue={largestValue}
                  step={currentStep}
                  algorithm={algorithm}
                  settledIndices={settledBarIndices}
                  completionSweepActive={completionSweepActive}
                  completionSweepStepDuration={completionSweepStepDuration}
                  prefersReducedMotion={prefersReducedMotion}
                  steps={steps}
                  initialStepIndex={stepIndex}
                  isRunning={isRunning}
                  getPlaybackTiming={getDenseCanvasPlaybackTiming}
                  onPlaybackIndex={handleDenseCanvasPlaybackIndex}
                  onVisualStep={handleDenseCanvasPlaybackVisualStep}
                  onAudioStep={handleDenseCanvasAudioStep}
                  onCheckpoint={handleDenseCanvasPlaybackCheckpoint}
                  onContextUnavailable={handleDenseCanvasContextUnavailable}
                />
              ) : (
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
                    return (
                      <SortingBarSlot
                        key={
                          shouldInterpolateMoves
                            ? "motion-" + item.token
                            : String(index) + "-" + String(originalValues.length)
                        }
                        value={item.value}
                        isGap={item.isGap}
                        height={height}
                        barClassName={getBarClass(index, currentStep, algorithm, settledBarIndices)}
                        showValue={arraySize <= 24}
                        motionToken={shouldInterpolateMoves ? item.token : null}
                        slideOffset={slideOffset}
                        onMotionBarRef={shouldInterpolateMoves ? setMotionBarRef : null}
                        completionScanDelay={
                          completionSweepActive && !prefersReducedMotion
                            ? COMPLETION_SWEEP_AUDIO_VISUAL_LEAD + index * completionSweepStepDuration
                            : undefined
                        }
                        completionScanDuration={
                          completionSweepActive && !prefersReducedMotion
                            ? completionSweepStepDuration
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              )}
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
                    <span><i className={"legend__swatch " + (algorithm === "quick" ? "legend__swatch--pivot" : "legend__swatch--key")} />pivot</span>
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
                <span ref={denseStagePassRef}>{currentStep.pass}</span>
                <em>{isBogo && bogoRunsUntilSolved ? " / ∞" : " / " + totalStages}</em>
              </strong>
              <p>{algorithmDetails.stageDescription}</p>
            </div>
            <div className="stat-card">
              <span>{isBogo ? "ORDER CHECKS" : "COMPARISONS"}</span>
              <strong ref={denseComparisonCountRef}>{currentStep.comparisons}</strong>
              <p>values checked</p>
            </div>
            <div className="stat-card">
              <span>{isBogo ? "SHUFFLE WRITES" : "ARRAY WRITES"}</span>
              <strong ref={denseWriteCountRef}>{currentStep.writes}</strong>
              <p>{isBogo ? "random swaps" : "moves + writes"}</p>
            </div>
            <div className="stat-card stat-card--progress">
              <span>{isBogo && bogoRunsUntilSolved && runState !== "complete" ? "OPEN ENDED" : "PROGRESS"}</span>
              <strong>
                <span ref={denseProgressValueRef}>{isBogo && bogoRunsUntilSolved && runState !== "complete" ? "∞" : progress}</span>
                {!(isBogo && bogoRunsUntilSolved && runState !== "complete") && <em>%</em>}
              </strong>
              <div className="progress-track" aria-hidden="true"><i ref={denseProgressFillRef} style={{ width: String(progress) + "%" }} /></div>
            </div>
          </div>
        </section>

        <section className="learn-grid" aria-labelledby="learn-title">
          <div className="learn-copy">
            <p className="eyebrow">{algorithmDetails.eyebrow}</p>
            <h2 id="learn-title">
              <span className="learn-copy__algorithm-name">{algorithmLabel}</span>
              <span className="learn-copy__flavor-title">{algorithmDetails.learnTitle}</span>
            </h2>
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

          <div className="algorithm-card-wrap">
            <div className="algorithm-card__header">
              <span>{algorithmDetails.cardTitle}</span>
              <span>{algorithmDetails.cardTag}</span>
            </div>
            <div className="algorithm-card">
              <div
                className="algorithm-card__tabs"
                role="tablist"
                aria-label={algorithmLabel + " algorithm details"}
              >
                <button
                  id={algorithm + "-walkthrough-tab"}
                  className="algorithm-card__tab"
                  type="button"
                  role="tab"
                  aria-selected={algorithmCardTab === "walkthrough"}
                  aria-controls={algorithm + "-walkthrough-panel"}
                  tabIndex={algorithmCardTab === "walkthrough" ? 0 : -1}
                  onClick={() => setAlgorithmCardTab("walkthrough")}
                  onKeyDown={(event) => handleAlgorithmCardTabKeyDown(event, "walkthrough")}
                >
                  Walkthrough
                </button>
                <button
                  id={algorithm + "-python-tab"}
                  className="algorithm-card__tab"
                  type="button"
                  role="tab"
                  aria-selected={algorithmCardTab === "python"}
                  aria-controls={algorithm + "-python-panel"}
                  tabIndex={algorithmCardTab === "python" ? 0 : -1}
                  onClick={() => setAlgorithmCardTab("python")}
                  onKeyDown={(event) => handleAlgorithmCardTabKeyDown(event, "python")}
                >
                  Python
                </button>
              </div>
              {algorithmCardTab === "walkthrough" ? (
                <div
                  id={algorithm + "-walkthrough-panel"}
                  className="algorithm-card__panel"
                  role="tabpanel"
                  aria-labelledby={algorithm + "-walkthrough-tab"}
                >
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
              ) : (
                <div
                  id={algorithm + "-python-panel"}
                  className="algorithm-card__panel algorithm-card__panel--python"
                  role="tabpanel"
                  aria-labelledby={algorithm + "-python-tab"}
                >
                  <div className="algorithm-card__code-heading">
                    <span>PYTHON IMPLEMENTATION</span>
                    <span>matches the visualizer&apos;s sorting rule</span>
                  </div>
                  <pre className="algorithm-card__code">
                    <code>{PYTHON_IMPLEMENTATIONS[algorithm]}</code>
                  </pre>
                </div>
              )}
            </div>
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
                <h3 id="practice-title">
                  {isBogoPractice
                    ? bogoPracticeEntered
                      ? "Take a chance and see the rule."
                      : "Enter the casino."
                    : "Move the blocks and see the rule."}
                </h3>
              </div>
              <span>
                {practiceFinished
                  ? "complete"
                  : isBogoPractice
                    ? bogoPracticeEntered
                      ? bogoPracticeRolling
                        ? "shuffling"
                        : String(bogoPracticeAttempts) + " gambles"
                      : "casino closed"
                    : "step " + String(practiceStepIndex + 1) + " of " + String(practiceSteps.length)}
              </span>
            </div>
            <p className="practice-lab__prompt">
              {practiceFinished
                ? isBogoPractice
                  ? "Chance found the only sorted order. Gamble again to start a fresh casino run."
                  : "You completed this small walkthrough. Restart it any time to practice the moves again."
                : isBogoPractice && !bogoPracticeEntered
                  ? "Open the four-block table, then let chance decide whether every value lands in order."
                  : currentPractice.prompt}
            </p>
            {isBogoPractice && bogoPracticeEntered && (
              <div className="practice-bogo-status" role="status" aria-live="polite">
                <span>GAMBLES</span>
                <strong>{bogoPracticeAttempts}</strong>
                <small>
                  {practiceFinished
                    ? bogoPracticeBusy
                      ? "Winning order found — success sound playing"
                      : "Lucky sorted order found"
                    : bogoPracticeRolling
                      ? "Cards are rolling through fresh orders"
                      : "One sorted order out of 24 possible rows"}
                </small>
              </div>
            )}
            {isPartitionPractice && !practiceFinished && partitionPivot !== null && partitionActiveRange && (
              <div className="practice-quick-status practice-partition-status" aria-label={"Current " + algorithmLabel + " partition"}>
                <span>
                  <strong>{isPdqPractice ? "Sampled pivot" : "Pivot"}</strong> {partitionPivot}
                </span>
                {partitionSampleValues.length > 0 && (
                  <span><strong>Sampled values</strong> {partitionSampleValues.join(", ")}</span>
                )}
                <span><strong>Working range</strong> slots {partitionActiveRange[0] + 1}–{partitionActiveRange[1] + 1}</span>
                <span>
                  <strong>{isPdqPractice ? "Certified" : "Already fixed"}</strong>{" "}
                  {partitionSettledValues.length ? partitionSettledValues.join(", ") : "none yet"}
                </span>
              </div>
            )}
            {isInsertionPractice && !practiceFinished && insertionKey !== null && (
              <div className="practice-quick-status practice-insertion-status" aria-label="Current insertion sort key">
                <span><strong>Key</strong> {insertionKey}</span>
                <span><strong>Rule</strong> larger values shift right, then the key fills one gap</span>
              </div>
            )}
            {currentPractice.decision && !practiceFinished && (
              <div className="practice-decision-status" aria-label="Current algorithm decision">
                {currentPractice.decision.power !== undefined && (
                  <span className="practice-decision-status__power">power {currentPractice.decision.power}</span>
                )}
                <strong>{currentPractice.decision.label}</strong>
                <span>{currentPractice.decision.detail}</span>
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
              {isBogoPractice
                ? bogoPracticeEntered
                  ? "Gamble runs one completely fresh Fisher-Yates shuffle. No block is draggable because Bogo Sort does not make a strategic move—it only keeps rolling until the entire row happens to be ordered."
                  : "Enter the casino to begin this four-value chance experiment. The table will play its own sound effects, using the same volume setting as the visualizer."
                : isPdqPractice
                ? "Gold is PDQ's sampled pivot and cyan badges show the values it inspected. Only this step's safe outcome stays; this zoomed branch then uses a tiny-piece cleanup when it is small enough."
                : isQuickPractice
                ? "The gold block is the parked pivot. Drop onto a block to swap it, or into a glowing gap to shift the row. Only the safe partition move stays, so the next pivot can never become stuck."
                : isInsertionPractice
                  ? "The yellow key is held outside the row while every larger value has already shifted right. Drag it—or click it and then the gap—directly into the one glowing empty slot. The other blocks are not draggable in this step."
                : "Click two blocks or drop one directly onto another to swap them. Drop into any glowing gap to shift the row instead. The final arrangement—not which value you started with—decides whether the move stays."}
            </p>
            {isPreparedInsertionPractice && insertionKey !== null && preparedInsertionKeyDrop && (
              <div className="practice-insertion-key-tray" aria-label={"Held insertion key " + insertionKey}>
                <span className="practice-insertion-key-tray__label">HELD KEY</span>
                <button
                  className={
                    "practice-block practice-block--insertion-key practice-insertion-key-tray__key " +
                    (insertionKeySelected ? "practice-block--selected " : "") +
                    (practiceDraggingId === "insertion-key" ? "practice-block--dragging " : "")
                  }
                  type="button"
                  onPointerDown={handlePreparedInsertionKeyPointerDown}
                  onPointerMove={handlePreparedInsertionKeyPointerMove}
                  onPointerUp={(event) => finishPreparedInsertionKeyDrag(event)}
                  onPointerCancel={(event) => finishPreparedInsertionKeyDrag(event, true)}
                  onClick={handlePreparedInsertionKeyClick}
                  aria-pressed={insertionKeySelected}
                  aria-grabbed={practiceDraggingId === "insertion-key"}
                  aria-label={"Held key " + insertionKey + ". Drag it into the glowing insertion gap."}
                  style={
                    practiceDraggingId === "insertion-key"
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
                  <span className="practice-block__value">{insertionKey}</span>
                  <span className="practice-block__badge">key</span>
                </button>
                <span className="practice-insertion-key-tray__instruction">
                  Drop into slot {preparedInsertionKeyDrop.gapIndex + 1}
                </span>
              </div>
            )}
            <div
              className={
                "practice-board " +
                (isBogoPractice ? "practice-board--bogo " : "") +
                (isPreparedInsertionPractice ? "practice-board--prepared-insertion " : "") +
                (isBogoPractice && !bogoPracticeEntered ? "practice-board--bogo-entry " : "") +
                (bogoPracticeRolling ? "practice-board--bogo-rolling " : "") +
                (practiceDraggingId ? "practice-board--dragging " : "") +
                (practiceFinished ? "practice-board--complete" : "")
              }
              ref={isBogoPractice ? undefined : practiceBoardRef}
              role={isBogoPractice && bogoPracticeEntered ? "list" : "group"}
              aria-busy={isBogoPractice ? bogoPracticeBusy : undefined}
              aria-label={
                isBogoPractice
                  ? bogoPracticeEntered
                    ? "Bogo sort four-value gamble row"
                    : "Bogo sort casino entry"
                  : algorithmLabel + " interactive practice blocks"
              }
            >
              {isBogoPractice ? (
                !bogoPracticeEntered ? (
                  <div className="practice-bogo-entry">
                    <span className="practice-bogo-entry__eyebrow">FOUR BLOCKS · 24 ORDERS</span>
                    <strong>One order wins.</strong>
                    <p>Enter to open the table and hear the casino intro.</p>
                    <button
                      className="button button--casino-enter"
                      type="button"
                      onClick={beginBogoPracticeCasino}
                      disabled={bogoPracticeBusy}
                      aria-describedby="bogo-practice-entry-help"
                    >
                      <span>Enter the casino</span>
                      <small>open the four-block table</small>
                    </button>
                    <span className="sr-only" id="bogo-practice-entry-help">
                      Opens the Bogo Sort practice table and plays its casino entry sound at the selected volume.
                    </span>
                  </div>
                ) : (
                  practiceValues.map((value, index) => (
                    <div
                      className={
                        "practice-block practice-block--bogo " +
                        (bogoPracticeRolling ? "practice-block--bogo-rolling " : "") +
                        (practiceFinished ? "practice-block--completed" : "")
                      }
                      key={"bogo-slot-" + index}
                      role="listitem"
                      aria-label={
                        "Value " + value +
                        (bogoPracticeRolling
                          ? ", rolling"
                          : practiceFinished
                            ? ", fixed in its final position"
                            : "")
                      }
                    >
                      <span className="practice-block__value">{value}</span>
                      {practiceFinished && (
                        <span className="practice-block__badge practice-block__badge--fixed">fixed</span>
                      )}
                    </div>
                  ))
                )
              ) : isPreparedInsertionPractice && preparedInsertionKeyDrop && insertionKey !== null ? (
                preparedInsertionKeyDrop.slots.map((value, index) =>
                  value === null ? (
                    <button
                      className={
                        "practice-insertion-gap " +
                        (practiceDraggingId === "insertion-key" &&
                        practiceDropMode === "insert" &&
                        practiceDropIndex === index
                          ? "practice-insertion-gap--target "
                          : "") +
                        (insertionKeySelected ? "practice-insertion-gap--ready " : "")
                      }
                      type="button"
                      key={"insertion-gap-" + index}
                      data-practice-insertion-gap
                      onClick={handlePreparedInsertionGapClick}
                      aria-label={
                        "Open insertion gap at slot " +
                        String(index + 1) +
                        ". Place held key " +
                        insertionKey +
                        " here."
                      }
                    >
                      <span aria-hidden="true">open gap</span>
                    </button>
                  ) : (
                    <button
                      className="practice-block practice-block--insertion-shifted"
                      type="button"
                      key={"insertion-slot-" + index + "-" + value}
                      ref={(element) => setPracticeBlockRef("value-" + value, element)}
                      data-practice-index={index}
                      disabled
                      aria-label={
                        "Value " + value + ", shifted right while key " + insertionKey + " is held"
                      }
                    >
                      <span className="practice-block__value">{value}</span>
                    </button>
                  ),
                )
              ) : (
                <>
              {practiceValues.map((value, index) => {
                      const practiceItemId = "value-" + value;
                      const isDragging = practiceDraggingId === practiceItemId;
                      const practiceGroup = getPracticeGroupAtIndex(practiceGroups, index);
                      const isGroupStart = practiceGroup?.range[0] === index;
                      const isGroupEnd = practiceGroup?.range[1] === index;
                      const isPracticeWalkthroughComplete = practiceFinished;
                      const isPartitionPivot =
                        !isPracticeWalkthroughComplete && isPartitionPractice && value === partitionPivot;
                      const isPartitionSettled =
                        isPracticeWalkthroughComplete ||
                        (!isPartitionPivot && partitionSettledValues.includes(value));
                      const isInPartitionRange =
                        isPracticeWalkthroughComplete ||
                        !isPartitionPractice ||
                        !partitionActiveRange ||
                        (index >= partitionActiveRange[0] && index <= partitionActiveRange[1]);
                      const isPdqSample =
                        !isPracticeWalkthroughComplete &&
                        isPdqPractice &&
                        !isPartitionPivot &&
                        partitionSampleValues.includes(value);
                      const isInsertionKey =
                        !isPracticeWalkthroughComplete && isInsertionPractice && value === insertionKey;
                      const partitionLabel = isPracticeWalkthroughComplete || isPartitionSettled
                        ? ", fixed in its final position"
                        : isPartitionPivot
                        ? ", current pivot"
                        : isPartitionPractice && !isInPartitionRange
                            ? ", outside the current partition"
                            : "";
                      const insertionLabel = isInsertionKey ? ", current insertion key" : "";
                      const groupLabel = practiceGroup
                        ? ", " + practiceGroup.label + (practiceGroup.active ? ", working group" : "") +
                          (practiceGroup.detail ? ". " + practiceGroup.detail : "")
                        : "";
                      return (
                        <Fragment key={practiceItemId}>
                          <span
                            className={
                              "practice-drop-slot " +
                              (activePracticeRunBoundarySlots.has(index)
                                ? "practice-drop-slot--active-run-boundary "
                                : "") +
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
                            (isPracticeWalkthroughComplete ? "practice-block--completed " : "") +
                            (isPartitionPivot ? "practice-block--partition-pivot " : "") +
                            (isPartitionSettled ? "practice-block--partition-settled " : "") +
                            (isPdqSample ? "practice-block--pdq-sample " : "") +
                            (isInsertionKey ? "practice-block--insertion-key " : "") +
                            (isPartitionPractice && !isPracticeWalkthroughComplete && isInPartitionRange ? "practice-block--partition-active " : "") +
                            (isPartitionPractice && !isPracticeWalkthroughComplete && !isInPartitionRange ? "practice-block--partition-waiting " : "") +
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
                          aria-label={"Value " + value + groupLabel + partitionLabel + insertionLabel}
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
                          {isPartitionPivot && <span className="practice-block__badge">pivot</span>}
                          {isPdqSample && <span className="practice-block__badge practice-block__badge--sample">sample</span>}
                          {isInsertionKey && <span className="practice-block__badge">key</span>}
                          {isPartitionSettled && <span className="practice-block__badge practice-block__badge--fixed">fixed</span>}
                        </button>
                        </Fragment>
                      );
                    })}
              <span
                className={
                  "practice-drop-slot " +
                  (activePracticeRunBoundarySlots.has(practiceValues.length)
                    ? "practice-drop-slot--active-run-boundary "
                    : "") +
                  (practiceDropMode === "insert" && practiceDropIndex === practiceValues.length && practiceDraggingId
                    ? "practice-drop-slot--target"
                    : "")
                }
                data-practice-drop-index={practiceValues.length}
                aria-hidden="true"
              />
                </>
              )}
            </div>
            <div className="practice-lab__actions">
              {isBogoPractice ? (
                bogoPracticeEntered ? (
                  <>
                    {!practiceFinished && (
                      <button
                        className="button button--gamble"
                        type="button"
                        onClick={handleBogoPracticeGamble}
                        disabled={bogoPracticeBusy}
                        aria-describedby="bogo-practice-gamble-help"
                      >
                        <span>{bogoPracticeRolling ? "Shuffling…" : "Gamble"}</span>
                        <small>
                          {bogoPracticeRolling
                            ? "the cards are rolling"
                            : "shuffle all 4 blocks"}
                        </small>
                      </button>
                    )}
                    {!practiceFinished && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => resetPractice()}
                        disabled={bogoPracticeBusy}
                      >
                        Leave casino
                      </button>
                    )}
                    {practiceFinished && (
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={beginBogoPracticeCasino}
                        disabled={bogoPracticeBusy}
                        aria-describedby="bogo-practice-gamble-help"
                      >
                        Gamble again
                      </button>
                    )}
                    <span className="sr-only" id="bogo-practice-gamble-help">
                      Each gamble rolls during the shuffle sound, then plays a result sound. After a failed shuffle lands, you can gamble again immediately; starting again stops the previous failure sound.
                    </span>
                  </>
                ) : null
              ) : practiceFinished ? (
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
              className={"benchmark-tab " + (benchmarkTab === "bars" ? "benchmark-tab--active" : "")}
              id="efficiency-bars-tab"
              type="button"
              role="tab"
              aria-selected={benchmarkTab === "bars"}
              aria-controls="efficiency-bars-panel"
              onClick={() => setBenchmarkTab("bars")}
            >
              Workload bars
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
                  This view illustrates each algorithm&apos;s growth shape for the selected arrangement.
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
            <div id="efficiency-bars-panel" className="workload-bars-panel" role="tabpanel" aria-labelledby="efficiency-bars-tab">
              <div className="workload-bars-panel__header">
                <div>
                  <p className="workload-bars-panel__eyebrow">ILLUSTRATIVE MODEL · SINGLE N</p>
                  <p className="workload-bars-panel__copy">
                    Choose one theoretical array size, then compare the modeled work directly.
                    Every visible bar uses the same linear scale, so length shows its share of the
                    largest selected workload.
                  </p>
                </div>

                <label className="workload-bars-size-control">
                  <span>Theoretical array size, N</span>
                  <select
                    value={workloadBarSize}
                    onChange={(event) => setWorkloadBarSize(Number(event.target.value))}
                    aria-label="Theoretical array size for workload bars"
                  >
                    {THEORY_BENCHMARK_SIZES.map((size) => (
                      <option key={size} value={size}>n = {formatCount(size)}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="workload-bars-toggle-list" role="group" aria-label="Algorithms shown in the workload bars">
                {BENCHMARK_ALGORITHMS.map((benchmarkAlgorithm) => {
                  const isVisible = visibleWorkloadBarAlgorithms[benchmarkAlgorithm.key];
                  return (
                    <button
                      className={"workload-bars-toggle " + (isVisible ? "workload-bars-toggle--active" : "")}
                      key={benchmarkAlgorithm.key}
                      type="button"
                      aria-pressed={isVisible}
                      onClick={() => handleWorkloadBarAlgorithmVisibilityToggle(benchmarkAlgorithm.key)}
                      style={{ "--workload-bar-color": BENCHMARK_COLORS[benchmarkAlgorithm.key] } as CSSProperties}
                    >
                      <i className={"benchmark-legend__swatch benchmark-legend__swatch--" + benchmarkAlgorithm.className} />
                      {benchmarkAlgorithm.label}
                    </button>
                  );
                })}
              </div>

              <section
                className="workload-bars"
                aria-label={
                  workloadBarRows.length
                    ? "Illustrative workload bars at n=" + formatCount(workloadBarEntry?.size ?? workloadBarSize) + "."
                    : "Illustrative workload bars. No algorithms are selected."
                }
              >
                <div className="workload-bars__scale">
                  <span>
                    {workloadBarRows.length
                      ? "Highest selected workload"
                      : "Removing selected workload"}
                  </span>
                  <strong>{formatCount(workloadBarMaximum)}</strong>
                  <p>
                    {benchmarkPattern === "random"
                      ? "Random-shuffle model"
                      : benchmarkPattern === "reverse"
                        ? "Reverse-order model"
                        : "Nearly-sorted model"}
                  </p>
                </div>

                {renderedWorkloadBarRows.length ? (
                  <ol className="workload-bars__list">
                    {renderedWorkloadBarRows.map((row) => {
                      const ratio = row.work / workloadBarMaximum;
                      const multiplier = row.work / workloadBarFastest;
                      const relativeLabel =
                        multiplier === 1
                          ? "fastest selected algorithm"
                          : formatWorkloadMultiplier(multiplier) + " the fastest selected algorithm";

                      return (
                        <li
                          key={row.key}
                          className={
                            "workload-bar-row-presence " +
                            (row.exitTransitionId !== undefined
                              ? "workload-bar-row-presence--exiting"
                              : row.enterTransitionId !== undefined
                                ? "workload-bar-row-presence--entering"
                                : "")
                          }
                          aria-hidden={row.exitTransitionId !== undefined || undefined}
                          onAnimationEnd={(event) => {
                            if (event.currentTarget !== event.target) return;
                            if (row.exitTransitionId !== undefined) {
                              handleWorkloadBarRowAnimationEnd(
                                row.key,
                                row.exitTransitionId,
                                "exiting",
                              );
                            } else if (row.enterTransitionId !== undefined) {
                              handleWorkloadBarRowAnimationEnd(
                                row.key,
                                row.enterTransitionId,
                                "entering",
                              );
                            }
                          }}
                        >
                          <div
                            className="workload-bar-row"
                            style={{ "--workload-bar-color": row.color } as CSSProperties}
                          >
                            <div className="workload-bar-row__heading">
                              <span>
                                <i className={"benchmark-legend__swatch benchmark-legend__swatch--" + row.className} />
                                {row.label}
                              </span>
                              <strong>{formatCount(row.work)}</strong>
                            </div>
                            <div
                              className="workload-bar-row__track"
                              role="progressbar"
                              aria-label={row.label + ": " + formatCount(row.work) + " modeled work, " + relativeLabel}
                              aria-valuemin={0}
                              aria-valuemax={Math.round(workloadBarMaximum)}
                              aria-valuenow={Math.round(row.work)}
                            >
                              <b style={{ width: String(ratio * 100) + "%" }} />
                            </div>
                            <small>{relativeLabel}</small>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="workload-bars__empty">Select at least one algorithm to compare its modeled workload.</p>
                )}
              </section>
            </div>
          )}
        </section>

        <p className="sr-only" aria-live={liveStatusPoliteness} aria-atomic="true">{liveStatus}</p>
      </div>
    </main>
  );
}
