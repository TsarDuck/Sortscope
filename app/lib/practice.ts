export type PracticeDropMode = "swap" | "insert";

export type PracticeTargetScore = {
  inversions: number;
  displacement: number;
};

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
