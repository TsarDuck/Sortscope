export type AlgorithmId = "insertion" | "mean-partition";

export type StepPhase =
  | "ready"
  | "select"
  | "compare"
  | "shift"
  | "insert"
  | "split"
  | "average"
  | "reorder"
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

export function createInitialStep(
  values: number[],
  algorithm: AlgorithmId = "insertion",
): SortStep {
  const isMeanPartition = algorithm === "mean-partition";

  return {
    values: [...values],
    pass: 0,
    phase: "ready",
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: isMeanPartition ? 0 : values.length ? 1 : 0,
    comparisons: 0,
    writes: 0,
    message: isMeanPartition
      ? values.length <= 1
        ? "One value is already ordered."
        : "The row will be repeatedly split into mean-ranked groups."
      : "The first value starts as a sorted one-item prefix.",
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

export function buildInsertionSteps(source: number[]): SortStep[] {
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

      if (values[j] <= key) break;

      values[j + 1] = values[j];
      writes += 1;
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
