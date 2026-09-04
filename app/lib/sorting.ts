export type AlgorithmId =
  | "insertion"
  | "cocktail"
  | "selection"
  | "heap"
  | "quick"
  | "merge"
  | "bogo"
  | "mean-partition";

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
};

type MeanChunk = {
  id: number;
  values: number[];
  sum: number;
  originalIndex: number;
};

export const BOGO_MAX_ATTEMPTS = 1_000_000;
const COMPACT_FRAME_THRESHOLD = 24;

export function createInitialStep(
  values: number[],
  algorithm: AlgorithmId = "insertion",
): SortStep {
  const isMeanPartition = algorithm === "mean-partition";
  const messages: Record<AlgorithmId, string> = {
    insertion: "The first value starts as a sorted one-item prefix.",
    cocktail: "The row will sweep forward and backward, swapping neighbors.",
    selection: "Find the smallest remaining value and place it at the front.",
    heap: "Build a max heap, then repeatedly move its largest value to the end.",
    quick: "Choose a pivot, partition around it, then repeat on each side.",
    merge: "Split the row into runs, then merge ordered neighbors.",
    bogo: "Shuffle the whole row until chance happens to order it.",
    "mean-partition": "The row will be repeatedly split into mean-ranked groups.",
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
        : isMeanPartition
          ? messages["mean-partition"]
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

function buildMeanChunks(values: number[], groupCount: number): MeanChunk[] {
  return partitionBalanced(values, groupCount).map((group, index) => ({
    id: index,
    values: group,
    sum: group.reduce((sum, value) => sum + value, 0),
    originalIndex: index,
  }));
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
  const ranked = [...chunks];
  let comparisons = 0;

  for (let index = 1; index < ranked.length; index += 1) {
    const candidate = ranked[index];
    let cursor = index - 1;

    while (cursor >= 0) {
      comparisons += 1;
      if (compareMeans(ranked[cursor], candidate) <= 0) break;
      ranked[cursor + 1] = ranked[cursor];
      cursor -= 1;
    }

    ranked[cursor + 1] = candidate;
  }

  return { chunks: ranked, comparisons };
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

export function buildMeanPartitionSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source, "mean-partition")];
  const values = [...source];
  let working = [...source];
  let groupCount = 2;
  let round = 0;
  let meansCalculated = 0;
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

  while (true) {
    round += 1;
    const chunks = buildMeanChunks(working, groupCount);
    const groups = describeMeanGroups(chunks);
    meansCalculated += chunks.length;

    steps.push({
      values: [...working],
      pass: round,
      phase: "split",
      key: null,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: 0,
      comparisons: meansCalculated,
      writes: valuesReordered,
      message:
        "Round " +
        round +
        ": split the row into " +
        chunks.length +
        " balanced groups.",
      groups,
    });

    const meanMessage =
      chunks.length <= 8
        ? "Group means: " +
          groups.map((group) => "μ " + formatMean(group.mean)).join(", ") +
          "."
        : "Measure the averages for all " + chunks.length + " groups.";

    steps.push({
      values: [...working],
      pass: round,
      phase: "average",
      key: null,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: 0,
      comparisons: meansCalculated,
      writes: valuesReordered,
      message: meanMessage,
      groups,
    });

    const rankedChunks = rankMeanChunks(chunks).chunks;
    valuesReordered += rankedChunks.reduce(
      (total, chunk, nextIndex) =>
        total + (chunk.originalIndex === nextIndex ? 0 : chunk.values.length),
      0,
    );
    working = rankedChunks.flatMap((chunk) => chunk.values);

    steps.push({
      values: [...working],
      pass: round,
      phase: "reorder",
      key: null,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: 0,
      comparisons: meansCalculated,
      writes: valuesReordered,
      message:
        "Rank the groups by mean: smallest on the left, largest on the right.",
      groups: describeMeanGroups(rankedChunks),
    });

    if (isNonDecreasing(working)) {
      steps.push({
        values: [...working],
        pass: round,
        phase: "complete",
        key: null,
        comparing: null,
        shifting: null,
        inserting: null,
        gapIndex: null,
        sortedCount: working.length,
        comparisons: meansCalculated,
        writes: valuesReordered,
        message:
          groupCount >= values.length
            ? "Singleton groups make each mean equal its value. Sorted."
            : "The row is already ordered, so no further splitting is needed.",
      });
      return steps;
    }

    if (groupCount >= values.length) break;
    groupCount = Math.min(values.length, groupCount * 2);
  }

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

export function analyzeMeanPartitionSort(source: number[]): SortMetrics {
  const sourceValues = [...source];
  let working = [...source];
  let groupCount = 2;
  let rounds = 0;
  let meansCalculated = 0;
  let rankComparisons = 0;
  let valuesReordered = 0;

  if (working.length <= 1) {
    return {
      comparisons: 0,
      rankComparisons: 0,
      writes: 0,
      rounds: 0,
      finalValues: working,
    };
  }

  while (true) {
    rounds += 1;
    const chunks = buildMeanChunks(working, groupCount);
    meansCalculated += chunks.length;
    const ranking = rankMeanChunks(chunks);
    rankComparisons += ranking.comparisons;
    const rankedChunks = ranking.chunks;

    valuesReordered += rankedChunks.reduce(
      (total, chunk, nextIndex) =>
        total + (chunk.originalIndex === nextIndex ? 0 : chunk.values.length),
      0,
    );
    working = rankedChunks.flatMap((chunk) => chunk.values);

    if (isNonDecreasing(working) || groupCount >= sourceValues.length) {
      return {
        comparisons: meansCalculated,
        rankComparisons,
        writes: valuesReordered,
        rounds,
        finalValues: working,
      };
    }

    groupCount = Math.min(sourceValues.length, groupCount * 2);
  }
}
