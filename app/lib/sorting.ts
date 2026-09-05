export type AlgorithmId =
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

export type StepPhase =
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

export type SortStep = {
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
  /**
   * Quick-sort-family visual aid. These indices currently match the final
   * sorted row, but are deliberately not part of an algorithm's accounting
   * or its proof that a pivot has been permanently placed.
   */
  visualSettled?: number[];
  /**
   * The pivot currently driving a Quick Sort partition. This is visual state
   * only: it lets the renderer keep the pivot visible even when its value is
   * already sitting in a final-looking slot.
   */
  pivotIndex?: number;
  rangeStart?: number;
  rangeEnd?: number;
  /** Powersort's tree depth for the boundary currently being scheduled. */
  nodePower?: number;
};

export type SortMetrics = {
  comparisons: number;
  rankComparisons: number;
  writes: number;
  rounds: number;
  finalValues: number[];
};

export type BogoSession = {
  values: number[];
  /** `null` deliberately represents the opt-in, unbounded live session. */
  attemptLimit: number | null;
  attempts: number;
  comparisons: number;
  writes: number;
  done: boolean;
  limited: boolean;
  initiallySorted: boolean;
};

export const BOGO_MAX_ATTEMPTS = 1_000_000;
const COMPACT_FRAME_THRESHOLD = 24;

export function createInitialStep(
  values: number[],
  algorithm: AlgorithmId = "insertion",
): SortStep {
  const messages: Record<AlgorithmId, string> = {
    insertion: "The first value starts as a sorted one-item prefix.",
    bubble: "Neighboring values will trade places as the largest bubbles right.",
    cocktail: "The row will sweep forward and backward, swapping neighbors.",
    selection: "Find the smallest remaining value and place it at the front.",
    heap: "Build a max heap, then repeatedly move its largest value to the end.",
    quick: "Choose a pivot, partition around it, then repeat on each side.",
    pdq: "Use guarded pivots, then switch tactics when a pattern fights back.",
    merge: "Split the row into runs, then merge ordered neighbors.",
    powersort: "Find naturally ordered runs, then merge them in a power-guided order.",
    bogo: "Shuffle the whole row until chance happens to order it.",
  };

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
        : messages[algorithm],
  };
}

export function isNonDecreasing(values: number[]) {
  return values.every((value, index) => index === 0 || values[index - 1] <= value);
}

export function buildInsertionSteps(
  source: number[],
  compactFrames = false,
): SortStep[] {
  const steps = [createInitialStep(source, "insertion")];
  const values = [...source];
  let comparisons = 0;
  let writes = 0;

  for (let i = 1; i < values.length; i += 1) {
    const key = values[i];
    let j = i - 1;
    // The implementation keeps the copied key in the working array until the
    // final write, while the visual model lifts it out immediately. The gap
    // begins at the key's old slot and travels left as larger values shift
    // right, so the learner can follow the actual insertion mechanism.
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
      if (!compactFrames) {
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
      if (!compactFrames) {
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

    // Compact timelines must still include a post-shift frame. Without it a
    // dense array appears to move the held key directly into its destination.
    if (compactFrames && compactShiftCount > 0) {
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

type StepDetails = Pick<
  SortStep,
  "pass" | "phase" | "comparisons" | "writes" | "message"
> &
  Partial<
    Pick<
      SortStep,
      | "key"
      | "comparing"
      | "shifting"
      | "inserting"
      | "gapIndex"
      | "sortedCount"
      | "settled"
      | "pivotIndex"
      | "rangeStart"
      | "rangeEnd"
      | "nodePower"
    >
  >;

function makeStep(values: number[], details: StepDetails): SortStep {
  return {
    values: [...values],
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: 0,
    ...details,
  };
}

function getSettledIndices(settled: Set<number>) {
  return Array.from(settled).sort((left, right) => left - right);
}

function getQuickVisualSettledIndices(values: number[], sortedValues: number[]) {
  const visualSettled: number[] = [];

  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === sortedValues[index]) visualSettled.push(index);
  }

  return visualSettled;
}

function countSortedCheck(values: number[]) {
  let comparisons = 0;

  for (let index = 1; index < values.length; index += 1) {
    comparisons += 1;
    if (values[index - 1] > values[index]) {
      return { sorted: false, comparisons };
    }
  }

  return { sorted: true, comparisons };
}

export function buildSelectionSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "selection")];
  const values = [...source];
  const settled = new Set<number>();
  let comparisons = 0;
  let writes = 0;

  for (let start = 0; start < values.length - 1; start += 1) {
    let minimum = start;
    const pass = start + 1;

    steps.push(
      makeStep(values, {
        pass,
        phase: "select",
        inserting: start,
        key: values[start],
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        message: "Pass " + pass + ": search for the smallest remaining value.",
      }),
    );

    for (let scan = start + 1; scan < values.length; scan += 1) {
      comparisons += 1;

      if (values[scan] < values[minimum]) {
        minimum = scan;
      }
    }

    if (minimum !== start) {
      [values[start], values[minimum]] = [values[minimum], values[start]];
      writes += 2;
      steps.push(
        makeStep(values, {
          pass,
          phase: "swap",
          comparing: minimum,
          shifting: start,
          comparisons,
          writes,
          settled: getSettledIndices(settled),
          message: "Place the smallest remaining value at the front.",
        }),
      );
    } else {
      steps.push(
        makeStep(values, {
          pass,
          phase: "insert",
          inserting: start,
          comparisons,
          writes,
          settled: getSettledIndices(settled),
          message: "The front value was already the smallest remaining value.",
        }),
      );
    }

    settled.add(start);
  }

  if (values.length > 0) settled.add(values.length - 1);
  steps.push(
    makeStep(values, {
      pass: Math.max(values.length - 1, 0),
      phase: "complete",
      comparisons,
      writes,
      sortedCount: values.length,
      settled: getSettledIndices(settled),
      message: "Each pass selected the next smallest value, so the row is ordered.",
    }),
  );

  return steps;
}

export function buildHeapSortSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "heap")];
  const values = [...source];
  const settled = new Set<number>();
  const compactFrames = values.length > COMPACT_FRAME_THRESHOLD;
  let pass = 0;
  let comparisons = 0;
  let writes = 0;

  function siftDown(rootIndex: number, heapSize: number, message: string) {
    let root = rootIndex;

    while (true) {
      const left = root * 2 + 1;
      if (left >= heapSize) return;
      const right = left + 1;
      let largest = left;

      if (right < heapSize) {
        comparisons += 1;
        if (values[right] > values[left]) largest = right;
      }

      comparisons += 1;
      if (values[root] >= values[largest]) return;

      if (!compactFrames) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "heapify",
            comparing: root,
            shifting: largest,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message,
          }),
        );
      }

      [values[root], values[largest]] = [values[largest], values[root]];
      writes += 2;
      if (!compactFrames) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "swap",
            comparing: root,
            shifting: largest,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Swap to restore the max-heap shape.",
          }),
        );
      }
      root = largest;
    }
  }

  if (values.length > 1) {
    pass = 1;
    steps.push(
      makeStep(values, {
        pass,
        phase: "select",
        inserting: 0,
        comparisons,
        writes,
        message: "Build a max heap so the largest value reaches the root.",
      }),
    );
    for (let root = Math.floor(values.length / 2) - 1; root >= 0; root -= 1) {
      siftDown(root, values.length, "Compare a parent with its largest child.");
    }
    steps.push(
      makeStep(values, {
        pass,
        phase: "heapify",
        inserting: 0,
        comparisons,
        writes,
        message: "The heap is ready: its largest value is at the root.",
      }),
    );
  }

  for (let end = values.length - 1; end > 0; end -= 1) {
    pass += 1;
    [values[0], values[end]] = [values[end], values[0]];
    writes += 2;
    settled.add(end);
    steps.push(
      makeStep(values, {
        pass,
        phase: "swap",
        comparing: 0,
        shifting: end,
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        message: "Move the heap's largest value into its final position.",
      }),
    );

    siftDown(0, end, "Sift the new root down through the remaining heap.");
    steps.push(
      makeStep(values, {
        pass,
        phase: "heapify",
        inserting: 0,
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        message: "Restore the heap before extracting its next largest value.",
      }),
    );
  }

  if (values.length > 0) settled.add(0);
  steps.push(
    makeStep(values, {
      pass,
      phase: "complete",
      comparisons,
      writes,
      sortedCount: values.length,
      settled: getSettledIndices(settled),
      message: "Successive heap extractions have ordered the full row.",
    }),
  );

  return steps;
}

function shuffleInPlace(values: number[], random: () => number) {
  let writes = 0;

  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.min(
      index,
      Math.max(0, Math.floor(random() * (index + 1))),
    );

    if (swapIndex !== index) {
      [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
      writes += 2;
    }
  }

  return writes;
}

// The live Bogo runner uses the browser's Math.random(), whose range is
// already [0, 1). Keep the defensive, injectable shuffle above for tests and
// callers that provide their own source, but skip its redundant clamping in
// the hot default path. This remains the same unbiased Fisher-Yates shuffle.
function shuffleInPlaceWithMathRandom(values: number[]) {
  let writes = 0;

  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));

    if (swapIndex !== index) {
      const value = values[index];
      values[index] = values[swapIndex];
      values[swapIndex] = value;
      writes += 2;
    }
  }

  return writes;
}

export function createBogoSession(
  source: number[],
  attemptLimit: number | null = BOGO_MAX_ATTEMPTS,
): BogoSession {
  const values = [...source];
  const initialCheck = countSortedCheck(values);
  const normalizedAttemptLimit =
    attemptLimit === null
      ? null
      : Math.max(
          1,
          Math.floor(Number.isFinite(attemptLimit) ? attemptLimit : BOGO_MAX_ATTEMPTS),
        );

  return {
    values,
    attemptLimit: normalizedAttemptLimit,
    attempts: 0,
    comparisons: initialCheck.comparisons,
    writes: 0,
    done: initialCheck.sorted,
    limited: false,
    initiallySorted: initialCheck.sorted,
  };
}

export function advanceBogoSession(
  session: BogoSession,
  random?: () => number,
) {
  if (session.done) return;

  session.attempts += 1;
  session.writes += random === undefined
    ? shuffleInPlaceWithMathRandom(session.values)
    : shuffleInPlace(session.values, random);

  // This is the live runner's hottest path. Keep the initial-session helper
  // allocation-friendly, but avoid allocating a `{ sorted, comparisons }`
  // result for every single shuffle. The comparison accounting remains
  // identical: stop at the first descending adjacent pair.
  let comparisons = 0;
  let sorted = true;
  for (let index = 1; index < session.values.length; index += 1) {
    comparisons += 1;
    if (session.values[index - 1] > session.values[index]) {
      sorted = false;
      break;
    }
  }
  session.comparisons += comparisons;

  if (sorted) {
    session.done = true;
    return;
  }

  if (session.attemptLimit !== null && session.attempts >= session.attemptLimit) {
    session.done = true;
    session.limited = true;
  }
}

export function getBogoSessionStep(session: BogoSession): SortStep {
  if (session.done && !session.limited) {
    return makeStep(session.values, {
      pass: session.attempts,
      phase: "complete",
      comparisons: session.comparisons,
      writes: session.writes,
      sortedCount: session.values.length,
      message: session.initiallySorted
        ? "By chance, the starting row is already ordered."
        : "Shuffle " + session.attempts + " finally landed on an ordered row.",
    });
  }

  if (session.done && session.limited) {
    const safetyLimit = session.attemptLimit ?? session.attempts;

    return makeStep(session.values, {
      pass: session.attempts,
      phase: "limited",
      comparisons: session.comparisons,
      writes: session.writes,
      message:
        "Safety stop after " + safetyLimit + " shuffles. Bogo Sort can take indefinitely; try a new row or another algorithm.",
    });
  }

  return makeStep(session.values, {
    pass: session.attempts,
    phase: "shuffle",
    comparisons: session.comparisons,
    writes: session.writes,
    message: "Shuffle " + session.attempts + ": still not ordered, so try again.",
  });
}

export function buildBubbleSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "bubble")];
  const values = [...source];
  const settled = new Set<number>();
  const compactFrames = values.length > COMPACT_FRAME_THRESHOLD;
  const visualInterval = Math.max(
    1,
    Math.ceil((values.length * Math.max(values.length - 1, 1)) / 1000),
  );
  let comparisons = 0;
  let writes = 0;
  let pass = 0;

  for (let upper = values.length - 1; upper > 0; upper -= 1) {
    pass += 1;
    let swapped = false;

    if (!compactFrames) {
      steps.push(
        makeStep(values, {
          pass,
          phase: "select",
          comparisons,
          writes,
          settled: getSettledIndices(settled),
          message: "Pass " + pass + ": bubble the largest remaining value to the right.",
        }),
      );
    }

    for (let index = 0; index < upper; index += 1) {
      comparisons += 1;
      if (!compactFrames) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "compare",
            comparing: index,
            shifting: index + 1,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Compare neighboring values " + values[index] + " and " + values[index + 1] + ".",
          }),
        );
      }

      if (values[index] > values[index + 1]) {
        [values[index], values[index + 1]] = [values[index + 1], values[index]];
        writes += 2;
        swapped = true;
        if (!compactFrames) {
          steps.push(
            makeStep(values, {
              pass,
              phase: "swap",
              comparing: index,
              shifting: index + 1,
              comparisons,
              writes,
              settled: getSettledIndices(settled),
              message: "Swap them so the larger value keeps moving right.",
            }),
          );
        }
      }

      if (compactFrames && (index % visualInterval === 0 || index === upper - 1)) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "sweep",
            comparing: index,
            shifting: index + 1,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Pass " + pass + ": the orange pair bubbles right through the row.",
          }),
        );
      }
    }

    settled.add(upper);
    steps.push(
      makeStep(values, {
        pass,
        phase: "insert",
        inserting: upper,
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        message: "The largest remaining value is fixed at the right edge.",
      }),
    );

    if (!swapped) {
      for (let index = 0; index < upper; index += 1) settled.add(index);
      break;
    }
  }

  values.forEach((_, index) => settled.add(index));
  steps.push(
    makeStep(values, {
      pass,
      phase: "complete",
      comparisons,
      writes,
      sortedCount: values.length,
      settled: getSettledIndices(settled),
      message: "Every pass bubbled one more largest value into its final place.",
    }),
  );

  return steps;
}

export function buildCocktailSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "cocktail")];
  const values = [...source];
  const settled = new Set<number>();
  const compactFrames = values.length > COMPACT_FRAME_THRESHOLD;
  // Keep the orange sweep readable without retaining thousands of full array
  // snapshots for a 256-value row. The interval targets roughly 500 sweep
  // frames across the entire dense run, rather than per directional pass.
  const visualInterval = Math.max(
    1,
    Math.ceil((values.length * Math.max(values.length - 1, 1)) / 1000),
  );
  let lower = 0;
  let upper = values.length - 1;
  let pass = 0;
  let comparisons = 0;
  let writes = 0;
  let swapped = false;

  while (lower < upper) {
    pass += 1;
    swapped = false;
    if (!compactFrames) {
      steps.push(
        makeStep(values, {
          pass,
          phase: "select",
          comparisons,
          writes,
          settled: getSettledIndices(settled),
          message: "Sweep " + pass + ": move the largest remaining value to the right.",
        }),
      );
    }

    for (let index = lower; index < upper; index += 1) {
      comparisons += 1;
      if (!compactFrames) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "compare",
            comparing: index,
            shifting: index + 1,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Compare neighboring values " + values[index] + " and " + values[index + 1] + ".",
          }),
        );
      }

      if (values[index] > values[index + 1]) {
        [values[index], values[index + 1]] = [values[index + 1], values[index]];
        writes += 2;
        swapped = true;
        if (!compactFrames) {
          steps.push(
            makeStep(values, {
              pass,
              phase: "swap",
              comparing: index,
              shifting: index + 1,
              comparisons,
              writes,
              settled: getSettledIndices(settled),
              message: "Swap them so the larger value travels right.",
            }),
          );
        }
      }

      if (
        compactFrames &&
        ((index - lower) % visualInterval === 0 || index === upper - 1)
      ) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "sweep",
            comparing: index,
            shifting: index + 1,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Sweep " + pass + ": the orange pair moves right through the row.",
          }),
        );
      }
    }

    settled.add(upper);
    steps.push(
      makeStep(values, {
        pass,
        phase: "insert",
        inserting: upper,
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        message: "The largest remaining value is fixed at the right edge.",
      }),
    );
    upper -= 1;

    if (!swapped || lower >= upper) break;

    pass += 1;
    swapped = false;
    if (!compactFrames) {
      steps.push(
        makeStep(values, {
          pass,
          phase: "select",
          comparisons,
          writes,
          settled: getSettledIndices(settled),
          message: "Sweep " + pass + ": move the smallest remaining value to the left.",
        }),
      );
    }

    for (let index = upper; index >= lower; index -= 1) {
      comparisons += 1;
      if (!compactFrames) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "compare",
            comparing: index,
            shifting: index + 1,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Compare neighboring values " + values[index] + " and " + values[index + 1] + ".",
          }),
        );
      }

      if (values[index] > values[index + 1]) {
        [values[index], values[index + 1]] = [values[index + 1], values[index]];
        writes += 2;
        swapped = true;
        if (!compactFrames) {
          steps.push(
            makeStep(values, {
              pass,
              phase: "swap",
              comparing: index,
              shifting: index + 1,
              comparisons,
              writes,
              settled: getSettledIndices(settled),
              message: "Swap them so the smaller value travels left.",
            }),
          );
        }
      }

      if (
        compactFrames &&
        ((upper - index) % visualInterval === 0 || index === lower)
      ) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "sweep",
            comparing: index,
            shifting: index + 1,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Sweep " + pass + ": the orange pair moves left through the row.",
          }),
        );
      }
    }

    settled.add(lower);
    steps.push(
      makeStep(values, {
        pass,
        phase: "insert",
        inserting: lower,
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        message: "The smallest remaining value is fixed at the left edge.",
      }),
    );
    lower += 1;

    if (!swapped) break;
  }

  steps.push(
    makeStep(values, {
      pass,
      phase: "complete",
      comparisons,
      writes,
      sortedCount: values.length,
      settled: values.map((_, index) => index),
      message: "Forward and backward sweeps have ordered the full row.",
    }),
  );

  return steps;
}

export function buildQuickSortSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "quick")];
  const values = [...source];
  const settled = new Set<number>();
  const stack = values.length > 1 ? [{ low: 0, high: values.length - 1 }] : [];
  const compactFrames = values.length > COMPACT_FRAME_THRESHOLD;
  let pass = 0;
  let comparisons = 0;
  let writes = 0;

  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;
    const { low, high } = range;

    if (low === high) {
      settled.add(low);
      continue;
    }

    pass += 1;
    const pivot = values[high];
    let store = low;
    steps.push(
      makeStep(values, {
        pass,
        phase: "select",
        key: pivot,
        inserting: high,
        pivotIndex: high,
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        message: "Partition " + pass + ": choose " + pivot + " as the pivot.",
      }),
    );

    for (let scan = low; scan < high; scan += 1) {
      comparisons += 1;
      if (!compactFrames) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "compare",
            key: pivot,
            comparing: scan,
            shifting: store,
            pivotIndex: high,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Compare " + values[scan] + " with pivot " + pivot + ".",
          }),
        );
      }

      if (values[scan] <= pivot) {
        if (scan !== store) {
          [values[scan], values[store]] = [values[store], values[scan]];
          writes += 2;
          if (!compactFrames) {
            steps.push(
              makeStep(values, {
                pass,
                phase: "swap",
                key: pivot,
                comparing: scan,
                shifting: store,
                pivotIndex: high,
                comparisons,
                writes,
                settled: getSettledIndices(settled),
                message: "Move the smaller value to the pivot's left side.",
              }),
            );
          }
        }
        store += 1;
      }
    }

    if (store !== high) {
      [values[store], values[high]] = [values[high], values[store]];
      writes += 2;
    }
    settled.add(store);
    steps.push(
      makeStep(values, {
        pass,
        phase: "insert",
        key: pivot,
        inserting: store,
        pivotIndex: store,
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        message: "Place pivot " + pivot + " in its final position.",
      }),
    );

    if (store + 1 < high) stack.push({ low: store + 1, high });
    if (low < store - 1) stack.push({ low, high: store - 1 });
  }

  steps.push(
    makeStep(values, {
      pass,
      phase: "complete",
      comparisons,
      writes,
      sortedCount: values.length,
      settled: values.map((_, index) => index),
      message: "Every pivot is in place, so the row is ordered.",
    }),
  );

  // This pass is visual-only: it lets the renderer light every value that is
  // presently sitting in its final sorted position, including values Quick
  // Sort has not selected as pivots. It intentionally does not touch the
  // comparison, write, partition, or benchmark counters above.
  const sortedValues = [...values];
  return steps.map((step) => ({
    ...step,
    visualSettled: getQuickVisualSettledIndices(step.values, sortedValues),
  }));
}

/**
 * Pattern-defeating quicksort (PDQsort) is still a quicksort at heart, but it
 * makes two practical changes that matter for a visualizer and real input:
 *
 * - A median-of-three pivot avoids the classic "last item" pattern trap.
 * - A depth budget notices repeatedly lopsided splits and switches that
 *   branch to heap sort, preserving O(n log n) worst-case work.
 *
 * Small ranges use insertion sort because its tiny constant cost beats the
 * bookkeeping of another partition. `runPdqSort` is deliberately shared by
 * the builder and analyzer so animation counters cannot drift from the
 * efficiency-lab counters.
 */
const PDQ_INSERTION_SORT_THRESHOLD = 16;

type PdqRange = {
  low: number;
  high: number;
  badAllowed: number;
};

type PdqSortRunOptions = {
  compactFrames?: boolean;
  onStep?: (step: SortStep) => void;
};

type PdqSortRunResult = {
  values: number[];
  comparisons: number;
  writes: number;
  rounds: number;
};

function runPdqSort(source: number[], options: PdqSortRunOptions = {}): PdqSortRunResult {
  const values = [...source];
  const settled = new Set<number>();
  const compactFrames = options.compactFrames ?? values.length > COMPACT_FRAME_THRESHOLD;
  let comparisons = 0;
  let writes = 0;
  let rounds = 0;
  let pass = 0;

  function record(details: Omit<StepDetails, "pass" | "comparisons" | "writes">) {
    options.onStep?.(
      makeStep(values, {
        pass,
        comparisons,
        writes,
        settled: getSettledIndices(settled),
        ...details,
      }),
    );
  }

  function compareValues(left: number, right: number) {
    comparisons += 1;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  function swapValues(left: number, right: number) {
    if (left === right) return false;
    [values[left], values[right]] = [values[right], values[left]];
    writes += 2;
    return true;
  }

  function medianOfThreeIndex(low: number, high: number) {
    const middle = low + Math.floor((high - low) / 2);
    const lowValue = values[low];
    const middleValue = values[middle];
    const highValue = values[high];

    if (compareValues(lowValue, middleValue) < 0) {
      if (compareValues(middleValue, highValue) < 0) return middle;
      return compareValues(lowValue, highValue) < 0 ? high : low;
    }

    if (compareValues(lowValue, highValue) < 0) return low;
    return compareValues(middleValue, highValue) < 0 ? high : middle;
  }

  function rangeIsAlreadySorted(low: number, high: number) {
    for (let index = low + 1; index <= high; index += 1) {
      if (compareValues(values[index - 1], values[index]) > 0) return false;
    }
    return true;
  }

  function settleRange(low: number, high: number) {
    for (let index = low; index <= high; index += 1) settled.add(index);
  }

  function insertionSortRange(low: number, high: number) {
    pass = ++rounds;
    const length = high - low + 1;
    const visualInterval = Math.max(1, Math.ceil(length / 8));
    record({
      phase: "select",
      rangeStart: low,
      rangeEnd: high + 1,
      message: "Finish this small partition with a direct insertion pass.",
    });

    for (let index = low + 1; index <= high; index += 1) {
      const key = values[index];
      let insertAt = index - 1;

      while (insertAt >= low) {
        const relation = compareValues(values[insertAt], key);
        if (!compactFrames) {
          record({
            phase: "compare",
            key,
            comparing: insertAt,
            inserting: index,
            rangeStart: low,
            rangeEnd: high + 1,
            message: "Compare the small-range key with the value before it.",
          });
        }
        if (relation <= 0) break;

        values[insertAt + 1] = values[insertAt];
        writes += 1;
        if (!compactFrames) {
          record({
            phase: "shift",
            key,
            shifting: insertAt + 1,
            gapIndex: insertAt,
            rangeStart: low,
            rangeEnd: high + 1,
            message: "Shift one larger value right inside the small partition.",
          });
        }
        insertAt -= 1;
      }

      values[insertAt + 1] = key;
      writes += 1;
      if (!compactFrames || (index - low) % visualInterval === 0 || index === high) {
        record({
          phase: "insert",
          key,
          inserting: insertAt + 1,
          rangeStart: low,
          rangeEnd: high + 1,
          message: "Place the key in its ordered spot inside the small partition.",
        });
      }
    }

    settleRange(low, high);
    if (compactFrames) {
      record({
        phase: "insert",
        rangeStart: low,
        rangeEnd: high + 1,
        message: "The small partition is now ordered.",
      });
    }
  }

  function heapSortRange(low: number, high: number) {
    pass = ++rounds;
    const length = high - low + 1;
    const visualInterval = Math.max(1, Math.ceil(length / 12));
    let visualSwaps = 0;

    record({
      phase: "heapify",
      rangeStart: low,
      rangeEnd: high + 1,
      message: "The pattern guard switches this stubborn branch to Heap Sort.",
    });

    function siftDown(rootIndex: number, heapSize: number) {
      let root = rootIndex;

      while (true) {
        const left = root * 2 + 1;
        if (left >= heapSize) return;
        const right = left + 1;
        let largest = left;

        if (right < heapSize && compareValues(values[low + right], values[low + left]) > 0) {
          largest = right;
        }

        if (compareValues(values[low + root], values[low + largest]) >= 0) return;

        swapValues(low + root, low + largest);
        visualSwaps += 1;
        if (!compactFrames || visualSwaps % visualInterval === 0) {
          record({
            phase: "swap",
            comparing: low + root,
            shifting: low + largest,
            rangeStart: low,
            rangeEnd: high + 1,
            message: "Sift the heap's larger child toward the root.",
          });
        }
        root = largest;
      }
    }

    for (let root = Math.floor(length / 2) - 1; root >= 0; root -= 1) {
      siftDown(root, length);
    }

    for (let end = length - 1; end > 0; end -= 1) {
      swapValues(low, low + end);
      visualSwaps += 1;
      if (!compactFrames || visualSwaps % visualInterval === 0) {
        record({
          phase: "swap",
          comparing: low,
          shifting: low + end,
          rangeStart: low,
          rangeEnd: high + 1,
          message: "Move this branch's current maximum to its ordered edge.",
        });
      }
      siftDown(0, end);
    }

    settleRange(low, high);
    record({
      phase: "heapify",
      rangeStart: low,
      rangeEnd: high + 1,
      message: "Heap Sort closes the guarded branch without risking a slow pattern.",
    });
  }

  function breakPatterns(low: number, high: number) {
    const length = high - low + 1;
    if (length < 8) return false;

    // PDQsort deliberately perturbs only the inside of a partition. That
    // keeps its lower/higher boundary valid while making repeated bad pivots
    // much less likely on structured input.
    const first = low + 1;
    const middle = low + Math.floor(length / 2);
    const last = high - 1;
    let changed = false;

    changed = swapValues(first, middle) || changed;
    changed = swapValues(middle, last) || changed;
    return changed;
  }

  function partition(low: number, high: number, pivot: number) {
    let left = low;
    let right = high;
    let didSwap = false;

    while (true) {
      while (true) {
        const relation = compareValues(values[left], pivot);
        if (!compactFrames) {
          record({
            phase: "compare",
            key: pivot,
            comparing: left,
            shifting: right,
            rangeStart: low,
            rangeEnd: high + 1,
            message: "Scan right until a value belongs on the pivot's other side.",
          });
        }
        if (relation >= 0) break;
        left += 1;
      }

      while (true) {
        const relation = compareValues(values[right], pivot);
        if (!compactFrames) {
          record({
            phase: "compare",
            key: pivot,
            comparing: right,
            shifting: left,
            rangeStart: low,
            rangeEnd: high + 1,
            message: "Scan left until a value belongs on the pivot's other side.",
          });
        }
        if (relation <= 0) break;
        right -= 1;
      }

      if (left >= right) return { split: right, didSwap };

      didSwap = swapValues(left, right) || didSwap;
      if (!compactFrames) {
        record({
          phase: "swap",
          key: pivot,
          comparing: left,
          shifting: right,
          rangeStart: low,
          rangeEnd: high + 1,
          message: "Trade the two values that landed on the wrong pivot side.",
        });
      }
      left += 1;
      right -= 1;
    }
  }

  function queueRange(stack: PdqRange[], low: number, high: number, badAllowed: number) {
    if (low > high) return;
    if (low === high) {
      settled.add(low);
      return;
    }
    stack.push({ low, high, badAllowed });
  }

  if (values.length === 1) settled.add(0);
  const initialBadAllowed = Math.max(1, Math.floor(Math.log2(Math.max(values.length, 2))) * 2);
  const stack: PdqRange[] =
    values.length > 1
      ? [{ low: 0, high: values.length - 1, badAllowed: initialBadAllowed }]
      : [];

  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;
    const { low, high } = range;
    const length = high - low + 1;

    if (length <= PDQ_INSERTION_SORT_THRESHOLD) {
      insertionSortRange(low, high);
      continue;
    }

    pass = ++rounds;
    const pivotIndex = medianOfThreeIndex(low, high);
    const pivot = values[pivotIndex];
    record({
      phase: "select",
      key: pivot,
      inserting: pivotIndex,
      rangeStart: low,
      rangeEnd: high + 1,
      message: "Partition " + pass + ": choose a median-of-three pivot.",
    });

    const { split, didSwap } = partition(low, high, pivot);
    const leftSize = split - low + 1;
    const rightSize = high - split;

    if (compactFrames) {
      record({
        phase: "insert",
        key: pivot,
        inserting: split,
        rangeStart: low,
        rangeEnd: high + 1,
        message: "Partition the branch around its guarded pivot.",
      });
    }

    // A Hoare partition that needed no swaps is often a sorted or almost
    // sorted run. Confirming the fully ordered case lets PDQsort finish it in
    // linear work instead of recursing through an already solved branch.
    if (!didSwap && rangeIsAlreadySorted(low, high)) {
      settleRange(low, high);
      record({
        phase: "insert",
        key: pivot,
        rangeStart: low,
        rangeEnd: high + 1,
        message: "This partition was already in order, so PDQsort keeps it intact.",
      });
      continue;
    }

    const smallerSide = Math.min(leftSize, rightSize);
    const isBadPartition = smallerSide * 8 < length;
    let childBadAllowed = range.badAllowed;

    if (isBadPartition) {
      childBadAllowed -= 1;

      if (childBadAllowed <= 0) {
        heapSortRange(low, high);
        continue;
      }

      const writesBeforePatternBreak = writes;
      const leftChanged = breakPatterns(low, split);
      const rightChanged = breakPatterns(split + 1, high);
      if (leftChanged || rightChanged || writes !== writesBeforePatternBreak) {
        record({
          phase: "swap",
          key: pivot,
          rangeStart: low,
          rangeEnd: high + 1,
          message: "A lopsided split triggers a small pattern-breaking shuffle.",
        });
      }
    }

    // Push the larger side first so the smaller side is handled next; that
    // keeps the explicit stack shallow while preserving the same work.
    if (leftSize > rightSize) {
      queueRange(stack, low, split, childBadAllowed);
      queueRange(stack, split + 1, high, childBadAllowed);
    } else {
      queueRange(stack, split + 1, high, childBadAllowed);
      queueRange(stack, low, split, childBadAllowed);
    }
  }

  return { values, comparisons, writes, rounds };
}

export function buildPdqSortSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "pdq")];
  const result = runPdqSort(source, {
    compactFrames: source.length > COMPACT_FRAME_THRESHOLD,
    onStep: (step) => steps.push(step),
  });

  steps.push(
    makeStep(result.values, {
      pass: result.rounds,
      phase: "complete",
      comparisons: result.comparisons,
      writes: result.writes,
      sortedCount: result.values.length,
      settled: result.values.map((_, index) => index),
      message: "Guarded pivots and targeted fallbacks have ordered the full row.",
    }),
  );

  // Like the existing Quick Sort renderer hint, this has no bearing on PDQ's
  // comparison/write counts. It simply lets already-correct bars turn green
  // while a partition elsewhere is still being animated.
  const sortedValues = [...result.values];
  return steps.map((step) => ({
    ...step,
    visualSettled: getQuickVisualSettledIndices(step.values, sortedValues),
  }));
}

export function buildMergeSortSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "merge")];
  const values = [...source];
  const compactFrames = values.length > COMPACT_FRAME_THRESHOLD;
  let width = 1;
  let pass = 0;
  let comparisons = 0;
  let writes = 0;

  while (width < values.length) {
    pass += 1;
    steps.push(
      makeStep(values, {
        pass,
        phase: "split",
        comparisons,
        writes,
        message: "Merge pass " + pass + ": join ordered runs of " + width + ".",
      }),
    );

    for (let left = 0; left < values.length; left += width * 2) {
      const middle = Math.min(left + width, values.length);
      const right = Math.min(left + width * 2, values.length);
      if (middle >= right) continue;

      const leftRun = values.slice(left, middle);
      const rightRun = values.slice(middle, right);
      let leftIndex = 0;
      let rightIndex = 0;
      let destination = left;
      const visualWriteInterval = Math.max(1, Math.ceil((right - left) / 24));

      function recordCompactMergeWrite() {
        if (
          !compactFrames ||
          ((destination - left) % visualWriteInterval !== 0 && destination !== right)
        ) {
          return;
        }

        steps.push(
          makeStep(values, {
            pass,
            phase: "merge",
            inserting: destination - 1,
            rangeStart: left,
            rangeEnd: right,
            comparisons,
            writes,
            message: "Write another ordered portion of the merged run.",
          }),
        );
      }

      while (leftIndex < leftRun.length && rightIndex < rightRun.length) {
        comparisons += 1;
        if (!compactFrames) {
          steps.push(
            makeStep(values, {
              pass,
              phase: "compare",
              comparing: left + leftIndex,
              shifting: middle + rightIndex,
              rangeStart: left,
              rangeEnd: right,
              comparisons,
              writes,
              message: "Compare the next value from each ordered run.",
            }),
          );
        }

        if (leftRun[leftIndex] <= rightRun[rightIndex]) {
          values[destination] = leftRun[leftIndex];
          leftIndex += 1;
        } else {
          values[destination] = rightRun[rightIndex];
          rightIndex += 1;
        }
        writes += 1;
        destination += 1;
        if (!compactFrames) {
          steps.push(
            makeStep(values, {
              pass,
              phase: "merge",
              inserting: destination - 1,
              rangeStart: left,
              rangeEnd: right,
              comparisons,
              writes,
              message: "Write the next smallest value into the merged run.",
            }),
          );
        } else {
          recordCompactMergeWrite();
        }
      }

      while (leftIndex < leftRun.length) {
        values[destination] = leftRun[leftIndex];
        leftIndex += 1;
        destination += 1;
        writes += 1;
        recordCompactMergeWrite();
      }

      while (rightIndex < rightRun.length) {
        values[destination] = rightRun[rightIndex];
        rightIndex += 1;
        destination += 1;
        writes += 1;
        recordCompactMergeWrite();
      }

      if (!compactFrames) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "merge",
            rangeStart: left,
            rangeEnd: right,
            comparisons,
            writes,
            message: "Merge two ordered runs into one larger ordered run.",
          }),
        );
      }
    }

    width *= 2;
  }

  steps.push(
    makeStep(values, {
      pass,
      phase: "complete",
      comparisons,
      writes,
      sortedCount: values.length,
      message: "The final merge leaves one fully ordered run.",
    }),
  );

  return steps;
}

type NaturalPowerRun = {
  start: number;
  end: number;
};

type PowerStackEntry = {
  run: NaturalPowerRun;
  power: number;
};

type PowerSortExecution = {
  values: number[];
  steps: SortStep[];
  comparisons: number;
  writes: number;
  rounds: number;
};

/**
 * Powersort first discovers monotone runs already present in the input. A
 * strictly decreasing run is reversed so every run reads from low to high;
 * equal values deliberately stay in an ascending run so later stable merges
 * preserve their relative order.
 *
 * Each boundary gets a `node power`: the first binary-tree level where the
 * two run centres differ. That lets the small stack merge deeper neighbours
 * before their shared outer boundary, rather than following Merge Sort's
 * fixed-width passes.
 */
function executePowerSort(
  source: number[],
  recordFrames: boolean,
): PowerSortExecution {
  const values = [...source];
  const steps = recordFrames ? [createInitialStep(source, "powersort")] : [];
  const compactFrames = values.length > COMPACT_FRAME_THRESHOLD;
  const runVisualInterval = Math.max(1, Math.ceil(values.length / 24));
  const boundaryVisualInterval = Math.max(1, Math.ceil(values.length / 24));
  let comparisons = 0;
  let writes = 0;
  let rounds = 0;
  let discoveredRuns = 0;
  let discoveredBoundaries = 0;

  function record(details: StepDetails) {
    if (!recordFrames) return;
    steps.push(makeStep(values, details));
  }

  function discoverNaturalRun(start: number): NaturalPowerRun {
    let end = start + 1;
    let reversed = false;

    if (end < values.length) {
      comparisons += 1;
      if (values[start] > values[end]) {
        reversed = true;
        end += 1;

        while (end < values.length) {
          comparisons += 1;
          if (values[end - 1] <= values[end]) break;
          end += 1;
        }

        let left = start;
        let right = end - 1;
        while (left < right) {
          [values[left], values[right]] = [values[right], values[left]];
          writes += 2;
          left += 1;
          right -= 1;
        }
      } else {
        end += 1;

        while (end < values.length) {
          comparisons += 1;
          if (values[end - 1] > values[end]) break;
          end += 1;
        }
      }
    }

    const run = { start, end };
    discoveredRuns += 1;
    const shouldShowRun =
      !compactFrames ||
      discoveredRuns === 1 ||
      end === values.length ||
      discoveredRuns % runVisualInterval === 0;

    if (shouldShowRun) {
      record({
        pass: rounds,
        phase: "run",
        rangeStart: start,
        rangeEnd: end,
        comparisons,
        writes,
        message: reversed
          ? "Natural run " + discoveredRuns + " descended, so flip it into ascending order."
          : "Natural run " + discoveredRuns + " already rises and can stay together.",
      });
    }

    return run;
  }

  function getNodePower(left: NaturalPowerRun, right: NaturalPowerRun) {
    const denominator = values.length * 2;
    let leftCentre = left.start * 2 + (left.end - left.start);
    let rightCentre = right.start * 2 + (right.end - right.start);
    let power = 0;

    // The run centres lie in [0, 1). Repeatedly expose their next binary
    // digit; the first mismatch is the boundary's tree depth. The visualizer
    // is capped at 256 bars, but the guard also keeps this arithmetic safe if
    // callers use larger arrays in a benchmark.
    while (leftCentre !== rightCentre && power < 53) {
      leftCentre *= 2;
      rightCentre *= 2;
      const leftBit = Math.floor(leftCentre / denominator);
      const rightBit = Math.floor(rightCentre / denominator);
      power += 1;

      if (leftBit !== rightBit) return power;

      leftCentre %= denominator;
      rightCentre %= denominator;
    }

    return Math.max(power, 1);
  }

  function recordBoundary(
    left: NaturalPowerRun,
    right: NaturalPowerRun,
    power: number,
  ) {
    discoveredBoundaries += 1;
    const shouldShowBoundary =
      !compactFrames ||
      discoveredBoundaries === 1 ||
      right.end === values.length ||
      discoveredBoundaries % boundaryVisualInterval === 0;

    if (!shouldShowBoundary) return;

    record({
      pass: Math.max(rounds + 1, 1),
      phase: "power",
      rangeStart: left.start,
      rangeEnd: right.end,
      nodePower: power,
      comparisons,
      writes,
      message:
        "Boundary power " +
        power +
        " schedules its deeper neighboring merges before this wider join.",
    });
  }

  function mergeRuns(
    left: NaturalPowerRun,
    right: NaturalPowerRun,
    boundaryPower: number,
  ): NaturalPowerRun {
    rounds += 1;
    const leftValues = values.slice(left.start, left.end);
    const rightValues = values.slice(right.start, right.end);
    let leftIndex = 0;
    let rightIndex = 0;
    let destination = left.start;
    const visualWriteInterval = Math.max(1, Math.ceil((right.end - left.start) / 24));

    record({
      pass: rounds,
      phase: "merge",
      rangeStart: left.start,
      rangeEnd: right.end,
      nodePower: boundaryPower,
      comparisons,
      writes,
      message: "Merge the next adjacent natural runs, keeping equal values in their original order.",
    });

    function recordCompactMergeWrite() {
      if (
        !compactFrames ||
        ((destination - left.start) % visualWriteInterval !== 0 &&
          destination !== right.end)
      ) {
        return;
      }

      record({
        pass: rounds,
        phase: "merge",
        inserting: destination - 1,
        rangeStart: left.start,
        rangeEnd: right.end,
        nodePower: boundaryPower,
        comparisons,
        writes,
        message: "Write another ordered portion of this scheduled merge.",
      });
    }

    while (leftIndex < leftValues.length && rightIndex < rightValues.length) {
      comparisons += 1;
      if (!compactFrames) {
        record({
          pass: rounds,
          phase: "compare",
          comparing: left.start + leftIndex,
          shifting: right.start + rightIndex,
          rangeStart: left.start,
          rangeEnd: right.end,
          nodePower: boundaryPower,
          comparisons,
          writes,
          message: "Compare the next value from each natural run.",
        });
      }

      if (leftValues[leftIndex] <= rightValues[rightIndex]) {
        values[destination] = leftValues[leftIndex];
        leftIndex += 1;
      } else {
        values[destination] = rightValues[rightIndex];
        rightIndex += 1;
      }
      destination += 1;
      writes += 1;

      if (!compactFrames) {
        record({
          pass: rounds,
          phase: "merge",
          inserting: destination - 1,
          rangeStart: left.start,
          rangeEnd: right.end,
          nodePower: boundaryPower,
          comparisons,
          writes,
          message: "Write the next stable value into the merged run.",
        });
      } else {
        recordCompactMergeWrite();
      }
    }

    while (leftIndex < leftValues.length) {
      values[destination] = leftValues[leftIndex];
      leftIndex += 1;
      destination += 1;
      writes += 1;
      recordCompactMergeWrite();
    }

    while (rightIndex < rightValues.length) {
      values[destination] = rightValues[rightIndex];
      rightIndex += 1;
      destination += 1;
      writes += 1;
      recordCompactMergeWrite();
    }

    if (!compactFrames) {
      record({
        pass: rounds,
        phase: "merge",
        rangeStart: left.start,
        rangeEnd: right.end,
        nodePower: boundaryPower,
        comparisons,
        writes,
        message: "Those natural runs are now one larger ordered run.",
      });
    }

    return { start: left.start, end: right.end };
  }

  if (values.length > 0) {
    let nextStart = 0;
    let current = discoverNaturalRun(nextStart);
    nextStart = current.end;
    const stack: PowerStackEntry[] = [];

    while (nextStart < values.length) {
      const next = discoverNaturalRun(nextStart);
      nextStart = next.end;
      const power = getNodePower(current, next);
      recordBoundary(current, next, power);

      // A smaller power means this new boundary is closer to the root of the
      // implicit merge tree, so every deeper pending boundary must close
      // first. This is the core Powersort stack rule.
      while (stack.length > 0 && stack[stack.length - 1].power > power) {
        const previous = stack.pop();
        if (!previous) break;
        current = mergeRuns(previous.run, current, previous.power);
      }

      stack.push({ run: current, power });
      current = next;
    }

    while (stack.length > 0) {
      const previous = stack.pop();
      if (!previous) break;
      current = mergeRuns(previous.run, current, previous.power);
    }
  }

  record({
    pass: rounds,
    phase: "complete",
    comparisons,
    writes,
    sortedCount: values.length,
    message:
      values.length <= 1
        ? "One value is already ordered."
        : "Natural runs have merged in power-guided order into one stable sorted row.",
  });

  return { values, steps, comparisons, writes, rounds };
}

export function buildPowerSortSteps(source: number[]): SortStep[] {
  return executePowerSort(source, true).steps;
}

export function buildBogoSteps(
  source: number[],
  attemptLimit = BOGO_MAX_ATTEMPTS,
  random: () => number = Math.random,
): SortStep[] {
  const steps = [createInitialStep(source, "bogo")];
  const values = [...source];
  let comparisons = 0;
  let writes = 0;
  const snapshotInterval = Math.max(
    values.length > 128 ? 50 : values.length > 64 ? 25 : values.length > 24 ? 10 : 5,
    Math.ceil(attemptLimit / 200),
  );

  const initialCheck = countSortedCheck(values);
  comparisons += initialCheck.comparisons;
  if (initialCheck.sorted) {
    steps.push(
      makeStep(values, {
        pass: 0,
        phase: "complete",
        comparisons,
        writes,
        sortedCount: values.length,
        message: "By chance, the starting row is already ordered.",
      }),
    );
    return steps;
  }

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    writes += shuffleInPlace(values, random);
    const check = countSortedCheck(values);
    comparisons += check.comparisons;
    const shouldShowShuffle = attempt <= 20 || attempt % snapshotInterval === 0;

    if (check.sorted) {
      steps.push(
        makeStep(values, {
          pass: attempt,
          phase: "complete",
          comparisons,
          writes,
          sortedCount: values.length,
          message: "Shuffle " + attempt + " finally landed on an ordered row.",
        }),
      );
      return steps;
    }

    if (shouldShowShuffle) {
      steps.push(
        makeStep(values, {
          pass: attempt,
          phase: "shuffle",
          comparisons,
          writes,
          message: "Shuffle " + attempt + ": still not ordered, so try again.",
        }),
      );
    }
  }

  steps.push(
    makeStep(values, {
      pass: attemptLimit,
      phase: "limited",
      comparisons,
      writes,
      message:
        "Safety stop after " + attemptLimit + " shuffles. Bogo Sort can take indefinitely; try a new row or another algorithm.",
    }),
  );

  return steps;
}

export function analyzeInsertionSort(source: number[]): SortMetrics {
  const values = [...source];
  let comparisons = 0;
  let writes = 0;

  for (let i = 1; i < values.length; i += 1) {
    const key = values[i];
    let j = i - 1;

    while (j >= 0) {
      comparisons += 1;
      if (values[j] <= key) break;
      values[j + 1] = values[j];
      writes += 1;
      j -= 1;
    }

    values[j + 1] = key;
    writes += 1;
  }

  return {
    comparisons,
    rankComparisons: 0,
    writes,
    rounds: Math.max(values.length - 1, 0),
    finalValues: values,
  };
}

export function analyzeBubbleSort(source: number[]): SortMetrics {
  const values = [...source];
  let comparisons = 0;
  let writes = 0;
  let rounds = 0;

  for (let upper = values.length - 1; upper > 0; upper -= 1) {
    rounds += 1;
    let swapped = false;
    for (let index = 0; index < upper; index += 1) {
      comparisons += 1;
      if (values[index] > values[index + 1]) {
        [values[index], values[index + 1]] = [values[index + 1], values[index]];
        writes += 2;
        swapped = true;
      }
    }
    if (!swapped) break;
  }

  return {
    comparisons,
    rankComparisons: 0,
    writes,
    rounds,
    finalValues: values,
  };
}

export function analyzeCocktailSort(source: number[]): SortMetrics {
  const values = [...source];
  let lower = 0;
  let upper = values.length - 1;
  let rounds = 0;
  let comparisons = 0;
  let writes = 0;

  while (lower < upper) {
    rounds += 1;
    let swapped = false;
    for (let index = lower; index < upper; index += 1) {
      comparisons += 1;
      if (values[index] > values[index + 1]) {
        [values[index], values[index + 1]] = [values[index + 1], values[index]];
        writes += 2;
        swapped = true;
      }
    }
    upper -= 1;
    if (!swapped || lower >= upper) break;

    rounds += 1;
    swapped = false;
    for (let index = upper; index >= lower; index -= 1) {
      comparisons += 1;
      if (values[index] > values[index + 1]) {
        [values[index], values[index + 1]] = [values[index + 1], values[index]];
        writes += 2;
        swapped = true;
      }
    }
    lower += 1;
    if (!swapped) break;
  }

  return {
    comparisons,
    rankComparisons: 0,
    writes,
    rounds,
    finalValues: values,
  };
}

export function analyzeSelectionSort(source: number[]): SortMetrics {
  const values = [...source];
  let comparisons = 0;
  let writes = 0;

  for (let start = 0; start < values.length - 1; start += 1) {
    let minimum = start;
    for (let scan = start + 1; scan < values.length; scan += 1) {
      comparisons += 1;
      if (values[scan] < values[minimum]) minimum = scan;
    }

    if (minimum !== start) {
      [values[start], values[minimum]] = [values[minimum], values[start]];
      writes += 2;
    }
  }

  return {
    comparisons,
    rankComparisons: 0,
    writes,
    rounds: Math.max(values.length - 1, 0),
    finalValues: values,
  };
}

export function analyzeHeapSort(source: number[]): SortMetrics {
  const values = [...source];
  let comparisons = 0;
  let writes = 0;

  function siftDown(rootIndex: number, heapSize: number) {
    let root = rootIndex;

    while (true) {
      const left = root * 2 + 1;
      if (left >= heapSize) return;
      const right = left + 1;
      let largest = left;

      if (right < heapSize) {
        comparisons += 1;
        if (values[right] > values[left]) largest = right;
      }

      comparisons += 1;
      if (values[root] >= values[largest]) return;
      [values[root], values[largest]] = [values[largest], values[root]];
      writes += 2;
      root = largest;
    }
  }

  for (let root = Math.floor(values.length / 2) - 1; root >= 0; root -= 1) {
    siftDown(root, values.length);
  }

  for (let end = values.length - 1; end > 0; end -= 1) {
    [values[0], values[end]] = [values[end], values[0]];
    writes += 2;
    siftDown(0, end);
  }

  return {
    comparisons,
    rankComparisons: 0,
    writes,
    rounds: values.length > 1 ? values.length : 0,
    finalValues: values,
  };
}

export function analyzeQuickSort(source: number[]): SortMetrics {
  const values = [...source];
  const stack = values.length > 1 ? [{ low: 0, high: values.length - 1 }] : [];
  let rounds = 0;
  let comparisons = 0;
  let writes = 0;

  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;
    const { low, high } = range;
    const pivot = values[high];
    let store = low;
    rounds += 1;

    for (let scan = low; scan < high; scan += 1) {
      comparisons += 1;
      if (values[scan] <= pivot) {
        if (scan !== store) {
          [values[scan], values[store]] = [values[store], values[scan]];
          writes += 2;
        }
        store += 1;
      }
    }

    if (store !== high) {
      [values[store], values[high]] = [values[high], values[store]];
      writes += 2;
    }

    if (store + 1 < high) stack.push({ low: store + 1, high });
    if (low < store - 1) stack.push({ low, high: store - 1 });
  }

  return {
    comparisons,
    rankComparisons: 0,
    writes,
    rounds,
    finalValues: values,
  };
}

export function analyzePdqSort(source: number[]): SortMetrics {
  const result = runPdqSort(source);

  return {
    comparisons: result.comparisons,
    rankComparisons: 0,
    writes: result.writes,
    rounds: result.rounds,
    finalValues: result.values,
  };
}

export function analyzeMergeSort(source: number[]): SortMetrics {
  const values = [...source];
  let width = 1;
  let rounds = 0;
  let comparisons = 0;
  let writes = 0;

  while (width < values.length) {
    rounds += 1;

    for (let left = 0; left < values.length; left += width * 2) {
      const middle = Math.min(left + width, values.length);
      const right = Math.min(left + width * 2, values.length);
      if (middle >= right) continue;

      const leftRun = values.slice(left, middle);
      const rightRun = values.slice(middle, right);
      let leftIndex = 0;
      let rightIndex = 0;
      let destination = left;

      while (leftIndex < leftRun.length && rightIndex < rightRun.length) {
        comparisons += 1;
        if (leftRun[leftIndex] <= rightRun[rightIndex]) {
          values[destination] = leftRun[leftIndex];
          leftIndex += 1;
        } else {
          values[destination] = rightRun[rightIndex];
          rightIndex += 1;
        }
        destination += 1;
        writes += 1;
      }

      while (leftIndex < leftRun.length) {
        values[destination] = leftRun[leftIndex];
        leftIndex += 1;
        destination += 1;
        writes += 1;
      }

      while (rightIndex < rightRun.length) {
        values[destination] = rightRun[rightIndex];
        rightIndex += 1;
        destination += 1;
        writes += 1;
      }
    }

    width *= 2;
  }

  return {
    comparisons,
    rankComparisons: 0,
    writes,
    rounds,
    finalValues: values,
  };
}

export function analyzePowerSort(source: number[]): SortMetrics {
  const result = executePowerSort(source, false);

  return {
    comparisons: result.comparisons,
    rankComparisons: 0,
    writes: result.writes,
    rounds: result.rounds,
    finalValues: result.values,
  };
}
