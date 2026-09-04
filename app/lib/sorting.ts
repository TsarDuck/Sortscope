export type AlgorithmId =
  | "insertion"
  | "bubble"
  | "cocktail"
  | "selection"
  | "heap"
  | "quick"
  | "merge"
  | "bogo"
  | "range-guard-mean";

export type StepPhase =
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

export type MeanGroup = {
  id: number;
  start: number;
  end: number;
  mean: number;
  rank: number;
};

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
  groups?: MeanGroup[];
  settled?: number[];
  rangeStart?: number;
  rangeEnd?: number;
};

export type SortMetrics = {
  comparisons: number;
  rankComparisons: number;
  writes: number;
  rounds: number;
  finalValues: number[];
  meanComputationOperations?: number;
  refinementOperations?: number;
};

export type BogoSession = {
  values: number[];
  attemptLimit: number;
  attempts: number;
  comparisons: number;
  writes: number;
  done: boolean;
  limited: boolean;
  initiallySorted: boolean;
};

type MeanChunk = {
  id: number;
  values: number[];
  sum: number;
  originalIndex: number;
};

export const BOGO_MAX_ATTEMPTS = 1_000_000;
const COMPACT_FRAME_THRESHOLD = 24;
const RANGE_GUARD_MIN_SIZE = 32;

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
    merge: "Split the row into runs, then merge ordered neighbors.",
    bogo: "Shuffle the whole row until chance happens to order it.",
    "range-guard-mean": "The row will use one broad mean rank, then exactly resolve only the crossing ranges.",
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

export function partitionBalanced<T>(values: T[], requestedGroupCount: number): T[][] {
  if (values.length === 0) return [];

  const groupCount = Math.max(
    1,
    Math.min(values.length, Math.floor(requestedGroupCount)),
  );
  const baseSize = Math.floor(values.length / groupCount);
  const remainder = values.length % groupCount;
  const groups: T[][] = [];
  let start = 0;

  for (let index = 0; index < groupCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0);
    groups.push(values.slice(start, start + size));
    start += size;
  }

  return groups;
}

export function formatMean(mean: number) {
  return Number.isInteger(mean) ? String(mean) : mean.toFixed(1);
}

function createMeanChunk(
  values: number[],
  id: number,
  originalIndex: number,
): MeanChunk {
  let sum = 0;

  for (const value of values) {
    sum += value;
  }

  return {
    id,
    values,
    sum,
    originalIndex,
  };
}

function buildMeanChunks(values: number[], groupCount: number) {
  return partitionBalanced(values, groupCount).map((group, index) =>
    createMeanChunk(group, index, index),
  );
}

function describeMeanGroups(chunks: MeanChunk[]): MeanGroup[] {
  let start = 0;

  return chunks.map((chunk, rank) => {
    const end = start + chunk.values.length;
    const group = {
      id: chunk.id,
      start,
      end,
      mean: chunk.sum / chunk.values.length,
      rank,
    };
    start = end;
    return group;
  });
}

function compareMeans(left: MeanChunk, right: MeanChunk) {
  const meanDifference =
    left.sum * right.values.length - right.sum * left.values.length;

  if (meanDifference !== 0) return meanDifference;
  return left.originalIndex - right.originalIndex;
}

function rankMeanChunks(chunks: MeanChunk[]) {
  let comparisons = 0;
  let alreadyOrdered = true;
  let strictlyReversed = chunks.length > 1;

  for (let index = 1; index < chunks.length; index += 1) {
    const order = compareMeans(chunks[index - 1], chunks[index]);
    comparisons += 1;
    if (order > 0) alreadyOrdered = false;
    // Equal means must preserve the incoming order, so only a strictly
    // decreasing run can be reversed as a stable fast path.
    if (order <= 0) strictlyReversed = false;
  }

  if (alreadyOrdered) return { chunks: [...chunks], comparisons };
  if (strictlyReversed) return { chunks: [...chunks].reverse(), comparisons };

  const ranked = [...chunks];

  ranked.sort((left, right) => {
    comparisons += 1;
    return compareMeans(left, right);
  });

  return { chunks: ranked, comparisons };
}

type RangeComponent = {
  chunks: MeanChunk[];
  values: number[];
};

type NaturalSortResult = {
  values: number[];
  comparisons: number;
  writes: number;
  frames: number[][];
};

type RangeFinishResult = {
  values: number[];
  inputChunks: MeanChunk[];
  chunks: MeanChunk[];
  comparisons: number;
  writes: number;
  frames: number[][];
  componentCount: number;
};

function getMaximum(values: number[]) {
  let maximum = values[0] ?? -Infinity;
  let comparisons = 0;

  for (let index = 1; index < values.length; index += 1) {
    comparisons += 1;
    if (values[index] > maximum) maximum = values[index];
  }

  return { value: maximum, comparisons };
}

function getMinimum(values: number[]) {
  let minimum = values[0] ?? Infinity;
  let comparisons = 0;

  for (let index = 1; index < values.length; index += 1) {
    comparisons += 1;
    if (values[index] < minimum) minimum = values[index];
  }

  return { value: minimum, comparisons };
}

/**
 * Finds certified value regions after mean ranking. A cut is safe only when
 * every value to its left is no greater than every value to its right; using
 * prefix maxima and suffix minima catches non-adjacent crossings too.
 */
function getRangeComponents(chunks: MeanChunk[]) {
  if (chunks.length === 0) return { components: [] as RangeComponent[], comparisons: 0 };
  if (chunks.length === 1) {
    return {
      components: [{ chunks: [...chunks], values: [...chunks[0].values] }],
      comparisons: 0,
    };
  }

  const prefixMaximums: number[] = [];
  const suffixMinimums: number[] = Array.from({ length: chunks.length });
  let comparisons = 0;
  let runningMaximum = -Infinity;
  let runningMinimum = Infinity;

  // The final chunk can never be on the left side of a boundary, so avoid an
  // unnecessary maximum scan. Likewise, the first chunk is never on the
  // right side. With two groups this is just max(left) versus min(right).
  for (let index = 0; index < chunks.length - 1; index += 1) {
    const maximum = getMaximum(chunks[index].values);
    comparisons += maximum.comparisons;
    if (index > 0) comparisons += 1;
    if (maximum.value > runningMaximum) runningMaximum = maximum.value;
    prefixMaximums[index] = runningMaximum;
  }

  for (let index = chunks.length - 1; index > 0; index -= 1) {
    const minimum = getMinimum(chunks[index].values);
    comparisons += minimum.comparisons;
    if (index < chunks.length - 1) comparisons += 1;
    if (minimum.value < runningMinimum) runningMinimum = minimum.value;
    suffixMinimums[index] = runningMinimum;
  }

  const components: RangeComponent[] = [];
  let componentStart = 0;

  for (let index = 0; index < chunks.length - 1; index += 1) {
    comparisons += 1;
    const isSafeBoundary = prefixMaximums[index] <= suffixMinimums[index + 1];
    if (!isSafeBoundary) continue;

    const componentChunks = chunks.slice(componentStart, index + 1);
    components.push({
      chunks: componentChunks,
      values: componentChunks.flatMap((chunk) => chunk.values),
    });
    componentStart = index + 1;
  }

  const componentChunks = chunks.slice(componentStart);
  components.push({
    chunks: componentChunks,
    values: componentChunks.flatMap((chunk) => chunk.values),
  });

  return { components, comparisons };
}

function sortNaturalRuns(source: number[]): NaturalSortResult {
  if (source.length <= 1) {
    return { values: [...source], comparisons: 0, writes: 0, frames: [] };
  }

  let values = [...source];
  let comparisons = 0;
  let writes = 0;
  const frames: number[][] = [];
  const runs: Array<{ start: number; end: number }> = [];
  let start = 0;
  let normalizedDescendingRun = false;

  while (start < values.length) {
    let end = start + 1;

    if (end < values.length) {
      comparisons += 1;
      const descending = values[end - 1] > values[end];
      end += 1;

      while (end < values.length) {
        comparisons += 1;
        const continues = descending ? values[end - 1] > values[end] : values[end - 1] <= values[end];
        if (!continues) break;
        end += 1;
      }

      if (descending) {
        let left = start;
        let right = end - 1;
        while (left < right) {
          const temporary = values[left];
          values[left] = values[right];
          values[right] = temporary;
          writes += 2;
          left += 1;
          right -= 1;
        }
        normalizedDescendingRun = true;
      }
    }

    runs.push({ start, end });
    start = end;
  }

  if (normalizedDescendingRun) frames.push([...values]);

  let workingRuns = runs;
  while (workingRuns.length > 1) {
    const nextValues = Array.from({ length: values.length }, () => 0);
    const nextRuns: Array<{ start: number; end: number }> = [];

    for (let index = 0; index < workingRuns.length; index += 2) {
      const leftRun = workingRuns[index];
      const rightRun = workingRuns[index + 1];

      if (!rightRun) {
        for (let cursor = leftRun.start; cursor < leftRun.end; cursor += 1) {
          nextValues[cursor] = values[cursor];
          writes += 1;
        }
        nextRuns.push(leftRun);
        continue;
      }

      let left = leftRun.start;
      let right = rightRun.start;
      let destination = leftRun.start;

      while (left < leftRun.end && right < rightRun.end) {
        comparisons += 1;
        if (values[left] <= values[right]) {
          nextValues[destination] = values[left];
          left += 1;
        } else {
          nextValues[destination] = values[right];
          right += 1;
        }
        destination += 1;
        writes += 1;
      }

      while (left < leftRun.end) {
        nextValues[destination] = values[left];
        left += 1;
        destination += 1;
        writes += 1;
      }

      while (right < rightRun.end) {
        nextValues[destination] = values[right];
        right += 1;
        destination += 1;
        writes += 1;
      }

      nextRuns.push({ start: leftRun.start, end: rightRun.end });
    }

    values = nextValues;
    workingRuns = nextRuns;
    frames.push([...values]);
  }

  return { values, comparisons, writes, frames };
}

function finishRangeComponents(chunks: MeanChunk[]): RangeFinishResult {
  const range = getRangeComponents(chunks);
  const sortedComponents = range.components.map((component) => sortNaturalRuns(component.values));
  const frameCount = sortedComponents.reduce(
    (largest, component) => Math.max(largest, component.frames.length),
    0,
  );
  const frames: number[][] = [];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    frames.push(
      sortedComponents.flatMap((component) => {
        if (component.frames.length === 0) return component.values;
        return component.frames[Math.min(frameIndex, component.frames.length - 1)];
      }),
    );
  }

  const finishedChunks = sortedComponents.map((component, index) =>
    createMeanChunk(component.values, index, index),
  );
  const inputChunks = range.components.map((component, index) =>
    createMeanChunk(component.values, index, index),
  );

  return {
    values:
      finishedChunks.length === 1
        ? finishedChunks[0].values
        : finishedChunks.flatMap((chunk) => chunk.values),
    inputChunks,
    chunks: finishedChunks,
    comparisons:
      range.comparisons +
      sortedComponents.reduce((total, component) => total + component.comparisons, 0),
    writes: sortedComponents.reduce((total, component) => total + component.writes, 0),
    frames,
    componentCount: range.components.length,
  };
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
      if (!compactFrames) {
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
      if (!compactFrames) {
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

export function buildRangeGuardMeanSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "range-guard-mean")];
  const values = [...source];
  let working = [...source];
  let pass = 0;
  let trackedComparisons = 0;
  let valuesReordered = 0;

  if (values.length <= 1) {
    steps.push({
      values: [...values],
      pass: 0,
      phase: "complete",
      key: null,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: values.length,
      comparisons: 0,
      writes: 0,
      message: "No grouping is needed; the row is already ordered.",
    });
    return steps;
  }

  let finish: RangeFinishResult;

  if (values.length >= RANGE_GUARD_MIN_SIZE) {
    pass = 1;
    const broadChunks = buildMeanChunks(working, 2);
    const broadGroups = describeMeanGroups(broadChunks);
    trackedComparisons += broadChunks.length;

    steps.push({
      values: [...working],
      pass,
      phase: "split",
      key: null,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: 0,
      comparisons: trackedComparisons,
      writes: valuesReordered,
      message: "Round 1: split the row into two broad mean groups.",
      groups: broadGroups,
    });

    steps.push({
      values: [...working],
      pass,
      phase: "average",
      key: null,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: 0,
      comparisons: trackedComparisons,
      writes: valuesReordered,
      message:
        "Group means: " + broadGroups.map((group) => "μ " + formatMean(group.mean)).join(", ") + ".",
      groups: broadGroups,
    });

    const ranking = rankMeanChunks(broadChunks);
    trackedComparisons += ranking.comparisons;
    const rankedChunks = ranking.chunks;
    valuesReordered += values.length;
    working = rankedChunks.flatMap((chunk) => chunk.values);

    steps.push({
      values: [...working],
      pass,
      phase: "reorder",
      key: null,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: 0,
      comparisons: trackedComparisons,
      writes: valuesReordered,
      message: "Rank the two broad groups by mean before inspecting their value ranges.",
      groups: describeMeanGroups(rankedChunks),
    });

    if (isNonDecreasing(working)) {
      steps.push({
        values: [...working],
        pass,
        phase: "complete",
        key: null,
        comparing: null,
        shifting: null,
        inserting: null,
        gapIndex: null,
        sortedCount: working.length,
        comparisons: trackedComparisons,
        writes: valuesReordered,
        message: "The broad mean rank already placed every value in order.",
      });
      return steps;
    }

    finish = finishRangeComponents(rankedChunks);
  } else {
    if (isNonDecreasing(working)) {
      steps.push({
        values: [...working],
        pass: 0,
        phase: "complete",
        key: null,
        comparing: null,
        shifting: null,
        inserting: null,
        gapIndex: null,
        sortedCount: working.length,
        comparisons: 0,
        writes: 0,
        message: "The small row is already ordered, so no scouting pass is needed.",
      });
      return steps;
    }

    pass = 1;
    finish = finishRangeComponents([createMeanChunk(working, 0, 0)]);
  }

  pass += 1;
  const finishGroups = describeMeanGroups(finish.inputChunks);
  trackedComparisons += finish.comparisons;

  steps.push({
    values: [...working],
    pass,
    phase: "split",
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: 0,
    comparisons: trackedComparisons,
    writes: valuesReordered,
    message:
      values.length < RANGE_GUARD_MIN_SIZE
        ? "Small row: skip mean scouting and finish its natural runs directly."
        : "Range guard finds " +
          finish.componentCount +
          " certified " +
          (finish.componentCount === 1 ? "value region" : "independent value regions") +
          ". Only those regions need exact local work.",
    groups: finishGroups,
  });

  valuesReordered += finish.writes;
  if (finish.componentCount > 1) valuesReordered += values.length;
  const finalGroups = describeMeanGroups(finish.chunks);

  finish.frames.forEach((frame, frameIndex) => {
    steps.push({
      values: [...frame],
      pass: pass + frameIndex,
      phase: "reorder",
      key: null,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: 0,
      comparisons: trackedComparisons,
      writes: valuesReordered,
      message:
        "Adaptive local finish " +
        (frameIndex + 1) +
        " of " +
        finish.frames.length +
        ": merge only the natural runs inside each guarded region.",
      groups: finalGroups,
    });
  });

  const finalPass = pass + Math.max(0, finish.frames.length - 1);
  steps.push({
    values: [...finish.values],
    pass: finalPass,
    phase: "complete",
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: finish.values.length,
    comparisons: trackedComparisons,
    writes: valuesReordered,
    message:
      "Certified range boundaries let the independently finished regions join into one sorted row.",
    groups: finalGroups,
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
      | "rangeStart"
      | "rangeEnd"
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
  const compactFrames = values.length > COMPACT_FRAME_THRESHOLD;
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
      if (!compactFrames) {
        steps.push(
          makeStep(values, {
            pass,
            phase: "compare",
            comparing: scan,
            shifting: minimum,
            inserting: start,
            comparisons,
            writes,
            settled: getSettledIndices(settled),
            message: "Compare the next value with the current minimum.",
          }),
        );
      }

      if (values[scan] < values[minimum]) {
        minimum = scan;
        if (!compactFrames) {
          steps.push(
            makeStep(values, {
              pass,
              phase: "select",
              comparing: scan,
              inserting: start,
              key: values[minimum],
              comparisons,
              writes,
              settled: getSettledIndices(settled),
              message: values[minimum] + " is the new smallest remaining value.",
            }),
          );
        }
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

export function createBogoSession(
  source: number[],
  attemptLimit = BOGO_MAX_ATTEMPTS,
): BogoSession {
  const values = [...source];
  const initialCheck = countSortedCheck(values);

  return {
    values,
    attemptLimit: Math.max(1, Math.floor(attemptLimit)),
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
  random: () => number = Math.random,
) {
  if (session.done) return;

  session.attempts += 1;
  session.writes += shuffleInPlace(session.values, random);
  const check = countSortedCheck(session.values);
  session.comparisons += check.comparisons;

  if (check.sorted) {
    session.done = true;
    return;
  }

  if (session.attempts >= session.attemptLimit) {
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
    return makeStep(session.values, {
      pass: session.attempts,
      phase: "limited",
      comparisons: session.comparisons,
      writes: session.writes,
      message:
        "Safety stop after " + session.attemptLimit + " shuffles. Bogo Sort can take indefinitely; try a new row or another algorithm.",
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

  return steps;
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

export function analyzeRangeGuardMeanSort(source: number[]): SortMetrics {
  const sourceValues = [...source];
  let working = [...sourceValues];
  let rounds = 0;
  let meansCalculated = 0;
  let meanComputationOperations = 0;
  let refinementOperations = 0;
  let rankComparisons = 0;
  let outputWrites = 0;

  if (sourceValues.length <= 1) {
    return {
      comparisons: 0,
      rankComparisons: 0,
      writes: 0,
      rounds: 0,
      finalValues: sourceValues,
      meanComputationOperations: 0,
      refinementOperations: 0,
    };
  }

  if (sourceValues.length >= RANGE_GUARD_MIN_SIZE) {
    rounds += 1;
    const broadChunks = buildMeanChunks(working, 2);
    meansCalculated += broadChunks.length;
    meanComputationOperations += sourceValues.length + broadChunks.length;
    const ranking = rankMeanChunks(broadChunks);
    rankComparisons += ranking.comparisons;
    outputWrites += sourceValues.length;
    working = ranking.chunks.flatMap((chunk) => chunk.values);

    if (isNonDecreasing(working)) {
      return {
        comparisons: meansCalculated,
        rankComparisons,
        writes: outputWrites,
        rounds,
        finalValues: working,
        meanComputationOperations,
        refinementOperations,
      };
    }

    const finish = finishRangeComponents(ranking.chunks);
    refinementOperations += finish.comparisons;
    outputWrites += finish.writes;
    if (finish.componentCount > 1) outputWrites += sourceValues.length;

    return {
      comparisons: meansCalculated,
      rankComparisons,
      writes: outputWrites,
      rounds: rounds + Math.max(1, finish.frames.length),
      finalValues: finish.values,
      meanComputationOperations,
      refinementOperations,
    };
  }

  if (isNonDecreasing(working)) {
    return {
      comparisons: 0,
      rankComparisons: 0,
      writes: 0,
      rounds: 0,
      finalValues: working,
      meanComputationOperations: 0,
      refinementOperations: 0,
    };
  }

  const finish = finishRangeComponents([createMeanChunk(working, 0, 0)]);
  refinementOperations += finish.comparisons;
  outputWrites += finish.writes;

  return {
    comparisons: 0,
    rankComparisons: 0,
    writes: outputWrites,
    rounds: Math.max(1, finish.frames.length),
    finalValues: finish.values,
    meanComputationOperations: 0,
    refinementOperations,
  };
}
