export type AlgorithmId =
  | "insertion"
  | "cocktail"
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

export const BOGO_MAX_VALUES = 5;
export const BOGO_MAX_ATTEMPTS = 720;

export function createInitialStep(
  values: number[],
  algorithm: AlgorithmId = "insertion",
): SortStep {
  const isMeanPartition = algorithm === "mean-partition";
  const messages: Record<AlgorithmId, string> = {
    insertion: "The first value starts as a sorted one-item prefix.",
    cocktail: "The row will sweep forward and backward, swapping neighbors.",
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
  const compactFrames = values.length > 64;
  let lower = 0;
  let upper = values.length - 1;
  let pass = 0;
  let comparisons = 0;
  let writes = 0;
  let swapped = false;

  while (lower < upper) {
    pass += 1;
    swapped = false;
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
  const compactFrames = values.length > 64;
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
  const compactFrames = values.length > 64;
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

      while (leftIndex < leftRun.length && rightIndex < rightRun.length) {
        comparisons += 1;
        if (!compactFrames) {
          steps.push(
            makeStep(values, {
              pass,
              phase: "compare",
              comparing: left + leftIndex,
              shifting: middle + rightIndex,
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
              comparisons,
              writes,
              message: "Write the next smallest value into the merged run.",
            }),
          );
        }
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

      steps.push(
        makeStep(values, {
          pass,
          phase: "merge",
          comparisons,
          writes,
          message: "Merge two ordered runs into one larger ordered run.",
        }),
      );
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
    const shouldShowShuffle = attempt <= 20 || attempt % 5 === 0;

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
        "Safety stop after " + attemptLimit + " shuffles. Bogo Sort can take indefinitely; try a new five-value row.",
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
