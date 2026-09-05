/** The input shapes available in the visualizer's control room. */
export type ArrayArrangement = "random" | "reverse" | "nearly-sorted";

type RandomSource = () => number;

function createAscendingArray(length: number) {
  return Array.from({ length }, (_, index) => index + 1);
}

function createRandomArray(length: number, random: RandomSource) {
  const values = createAscendingArray(length);

  // Fisher-Yates gives every permutation the same chance, unlike repeatedly
  // sorting with a random comparator. Keeping the random source injectable
  // also lets the visualizer's behavior be tested deterministically.
  for (let index = values.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(random() * (index + 1));
    [values[index], values[targetIndex]] = [values[targetIndex], values[index]];
  }

  return values;
}

function createNearlySortedArray(length: number) {
  const values = createAscendingArray(length);

  if (length < 2) return values;

  // One adjacent exchange is enough to make small rows visibly non-sorted.
  // Larger rows get a sparse, evenly distributed set of disjoint exchanges:
  // exactly one inversion per exchange, so the shape remains nearly sorted.
  const swapCount = Math.max(1, Math.min(Math.floor(length / 16), Math.floor(length / 2)));

  for (let swap = 0; swap < swapCount; swap += 1) {
    const index = Math.min(
      length - 2,
      Math.max(0, Math.round(((swap + 0.5) * length) / swapCount - 0.5)),
    );
    [values[index], values[index + 1]] = [values[index + 1], values[index]];
  }

  return values;
}

/**
 * Creates the visualizer's 1-through-N data set in a requested arrangement.
 * `random` is only used by the random-shuffle path and defaults to Math.random.
 */
export function makeArrayForArrangement(
  length: number,
  arrangement: ArrayArrangement,
  random: RandomSource = Math.random,
) {
  const safeLength = Math.max(0, Math.floor(length));

  switch (arrangement) {
    case "reverse":
      return createAscendingArray(safeLength).reverse();
    case "nearly-sorted":
      return createNearlySortedArray(safeLength);
    case "random":
      return createRandomArray(safeLength, random);
  }
}
