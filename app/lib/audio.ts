/**
 * The visualizer uses a practical continuous frequency ramp for dense rows,
 * but a short row can give every distinct value a real 12-tone piano pitch.
 * Keeping the mapping here makes live steps and the completion scan agree.
 */
export const PIANO_TONE_MIN_ARRAY_SIZE = 4;
export const PIANO_TONE_MAX_ARRAY_SIZE = 25;
export const PIANO_TONE_LOW_FREQUENCY = 261.6255653005986; // C4
export const PIANO_TONE_SEMITONE_SPAN = 24; // C4 through C6

export function getContinuousToneFrequency(value: number, largestValue: number) {
  const normalizedValue = Math.min(
    1,
    Math.max(0, (value - 1) / Math.max(largestValue - 1, 1)),
  );
  const compressedValue = Math.sqrt(normalizedValue);

  // Keep the C4-to-C6-ish range for dense rows, but interpolate rather than
  // quantizing so neighboring values retain their individual positions.
  return PIANO_TONE_LOW_FREQUENCY * 2 ** ((compressedValue * PIANO_TONE_SEMITONE_SPAN) / 12);
}

/**
 * Return a distinct, ascending piano pitch for each distinct value in a
 * short row. Values are ranked numerically instead of assumed to be 1..N, so
 * the same helper still behaves predictably for a custom input in the future.
 */
export function createSmallArrayPianoToneMap(values: readonly number[]) {
  if (values.length < PIANO_TONE_MIN_ARRAY_SIZE || values.length > PIANO_TONE_MAX_ARRAY_SIZE) {
    return null;
  }

  const sortedUniqueValues = [...new Set(values)].sort((left, right) => left - right);
  if (sortedUniqueValues.length === 0) return null;

  const lastIndex = Math.max(sortedUniqueValues.length - 1, 1);
  return new Map(
    sortedUniqueValues.map((value, index) => {
      // Integer semitones make every short-array tone a standard equal-
      // temperament piano note. With 25 unique values this is C4..C6 exactly.
      const semitones = Math.round((index * PIANO_TONE_SEMITONE_SPAN) / lastIndex);
      const frequency = PIANO_TONE_LOW_FREQUENCY * 2 ** (semitones / 12);
      return [value, frequency] as const;
    }),
  );
}
