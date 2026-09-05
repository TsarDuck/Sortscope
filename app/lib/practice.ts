export type PracticeDropMode = "swap" | "insert";

export type PracticeDropTarget = {
  index: number;
  mode: PracticeDropMode;
};

/**
 * The small geometry record used by the hands-on board. Keeping this decision
 * outside the React event handlers makes the two drop affordances testable:
 * land on a block to swap, or land between blocks to insert.
 */
export type PracticeDropRegion = {
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type PracticeTargetScore = {
  inversions: number;
  displacement: number;
};

/**
 * Make one unbiased Fisher-Yates shuffle for the Bogo hands-on experiment.
 *
 * The random source is injectable so the interaction can be verified without
 * relying on chance. The returned row is always a new array; the original
 * lesson row remains available for reset and completion checks.
 */
export function shufflePracticeValues<T>(
  values: readonly T[],
  random: () => number = Math.random,
) {
  const nextValues = [...values];

  for (let index = nextValues.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(random() * (index + 1));
    [nextValues[index], nextValues[targetIndex]] = [nextValues[targetIndex], nextValues[index]];
  }

  return nextValues;
}

/**
 * Apply the two kinds of move the hands-on lessons accept.
 *
 * A block dropped directly on another block trades places with it. A block
 * dropped into a gap is removed first, then inserted at that gap, shifting the
 * blocks between its old and new positions by one place.
 */
export function applyPracticeMove(
  values: readonly number[],
  fromIndex: number,
  toIndex: number,
  mode: PracticeDropMode,
) {
  const nextValues = [...values];
  if (
    fromIndex < 0 ||
    fromIndex >= nextValues.length ||
    toIndex < 0 ||
    toIndex > nextValues.length
  ) {
    return nextValues;
  }

  if (mode === "swap") {
    if (toIndex >= nextValues.length || fromIndex === toIndex) return nextValues;
    [nextValues[fromIndex], nextValues[toIndex]] = [nextValues[toIndex], nextValues[fromIndex]];
    return nextValues;
  }

  // Drop-slot indexes describe gaps in the row before the source is removed.
  // Moving right therefore shifts the insertion index left by one afterward.
  const insertionIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
  if (insertionIndex === fromIndex) return nextValues;

  const [movedValue] = nextValues.splice(fromIndex, 1);
  if (movedValue === undefined) return nextValues;
  nextValues.splice(insertionIndex, 0, movedValue);
  return nextValues;
}

/**
 * Return true only when a lesson row is genuinely complete.
 *
 * A row being numerically increasing alone is not enough for a generic
 * exercise: it must still contain exactly the same values as the lesson it
 * began with. In normal use moves preserve that permutation, but keeping the
 * check explicit makes the completion guard safe and independently testable.
 */
export function isPracticeRowFinished(
  values: readonly number[],
  expectedValues: readonly number[],
) {
  if (values.length === 0 || values.length !== expectedValues.length) return false;

  const expectedCounts = new Map<number, number>();
  for (const value of expectedValues) {
    expectedCounts.set(value, (expectedCounts.get(value) ?? 0) + 1);
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const remaining = expectedCounts.get(value) ?? 0;
    if (remaining === 0) return false;
    expectedCounts.set(value, remaining - 1);
    if (index > 0 && values[index - 1] > value) return false;
  }

  return true;
}

function regionContainsPoint(region: PracticeDropRegion, x: number, y: number) {
  return x >= region.left && x <= region.right && y >= region.top && y <= region.bottom;
}

function squaredDistanceToRegionCenter(region: PracticeDropRegion, x: number, y: number) {
  const centerX = region.left + (region.right - region.left) / 2;
  const centerY = region.top + (region.bottom - region.top) / 2;
  return (x - centerX) ** 2 + (y - centerY) ** 2;
}

/**
 * Resolve a drop without relying on React state. Direct block hitboxes win so
 * a person can always swap by dropping on a value. A true gap represents an
 * insertion point; otherwise, fall back to the nearest other block so the
 * familiar Quick Sort-style drop remains forgiving. The source is excluded
 * because its floating drag preview stays under the pointer while it is being
 * moved. Its original location is optional so releasing near the pickup spot
 * stays a no-op instead of accidentally choosing a neighbor.
 */
export function resolvePracticeDropTarget(
  x: number,
  y: number,
  sourceIndex: number,
  blocks: readonly PracticeDropRegion[],
  gaps: readonly PracticeDropRegion[],
  sourceOrigin?: PracticeDropRegion,
): PracticeDropTarget | null {
  const directBlock = blocks
    .filter((block) => block.index !== sourceIndex && regionContainsPoint(block, x, y))
    .sort(
      (left, right) =>
        squaredDistanceToRegionCenter(left, x, y) - squaredDistanceToRegionCenter(right, x, y),
    )[0];

  if (directBlock) return { index: directBlock.index, mode: "swap" };

  const directGap = gaps
    .filter((gap) => regionContainsPoint(gap, x, y))
    .sort(
      (left, right) =>
        squaredDistanceToRegionCenter(left, x, y) - squaredDistanceToRegionCenter(right, x, y),
    )[0];
  if (directGap) return { index: directGap.index, mode: "insert" };

  if (sourceOrigin && regionContainsPoint(sourceOrigin, x, y)) return null;

  const nearestBlock = blocks
    .filter((block) => block.index !== sourceIndex)
    .sort(
      (left, right) =>
        squaredDistanceToRegionCenter(left, x, y) - squaredDistanceToRegionCenter(right, x, y),
    )[0];
  if (nearestBlock) return { index: nearestBlock.index, mode: "swap" };

  if (gaps.length === 0) return null;

  let nearestGap = gaps[0];
  let nearestDistance = squaredDistanceToRegionCenter(nearestGap, x, y);
  for (const gap of gaps.slice(1)) {
    const distance = squaredDistanceToRegionCenter(gap, x, y);
    if (distance < nearestDistance) {
      nearestGap = gap;
      nearestDistance = distance;
    }
  }

  return { index: nearestGap.index, mode: "insert" };
}

/**
 * Measure a row against the lesson's requested order.
 *
 * The inversion count answers the important teaching question first: are more
 * pairs in the right relative order? Displacement only breaks ties between
 * rows with the same pair ordering, so a useful swap is never rejected merely
 * because two values trade equally distant seats.
 */
export function getPracticeTargetScore(
  values: readonly number[],
  target: readonly number[],
): PracticeTargetScore {
  if (values.length !== target.length) {
    return { inversions: Number.POSITIVE_INFINITY, displacement: Number.POSITIVE_INFINITY };
  }

  const targetRanks = new Map<number, number>();
  for (let index = 0; index < target.length; index += 1) {
    const value = target[index];
    if (targetRanks.has(value)) {
      return { inversions: Number.POSITIVE_INFINITY, displacement: Number.POSITIVE_INFINITY };
    }
    targetRanks.set(value, index);
  }

  const ranks: number[] = [];
  let displacement = 0;
  for (let index = 0; index < values.length; index += 1) {
    const rank = targetRanks.get(values[index]);
    if (rank === undefined) {
      return { inversions: Number.POSITIVE_INFINITY, displacement: Number.POSITIVE_INFINITY };
    }
    ranks.push(rank);
    displacement += Math.abs(index - rank);
  }

  let inversions = 0;
  for (let left = 0; left < ranks.length; left += 1) {
    for (let right = left + 1; right < ranks.length; right += 1) {
      if (ranks[left] > ranks[right]) inversions += 1;
    }
  }

  return { inversions, displacement };
}

export function isPracticeMoveProgress(
  previousValues: readonly number[],
  nextValues: readonly number[],
  target: readonly number[],
) {
  const previous = getPracticeTargetScore(previousValues, target);
  const next = getPracticeTargetScore(nextValues, target);
  return (
    next.inversions < previous.inversions ||
    (next.inversions === previous.inversions && next.displacement < previous.displacement)
  );
}
