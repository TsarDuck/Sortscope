import assert from "node:assert/strict";
import test from "node:test";
import {
  PIANO_TONE_LOW_FREQUENCY,
  createSmallArrayPianoToneMap,
  getContinuousToneFrequency,
} from "../app/lib/audio";

test("short rows assign every distinct value an ascending piano note", () => {
  const tones = createSmallArrayPianoToneMap([4, 1, 3, 2]);

  assert.ok(tones);
  const ordered = [1, 2, 3, 4].map((value) => tones.get(value) ?? 0);
  assert.equal(ordered[0], PIANO_TONE_LOW_FREQUENCY);
  assert.equal(ordered.at(-1), PIANO_TONE_LOW_FREQUENCY * 4);
  assert.ok(ordered.every((tone, index) => index === 0 || ordered[index - 1] < tone));
  assert.ok(
    ordered.every((tone) => {
      const semitones = Math.log2(tone / PIANO_TONE_LOW_FREQUENCY) * 12;
      return Math.abs(semitones - Math.round(semitones)) < 0.000_000_1;
    }),
  );
});

test("a 25-value row uses every piano semitone from C4 through C6", () => {
  const tones = createSmallArrayPianoToneMap(
    Array.from({ length: 25 }, (_, index) => 25 - index),
  );

  assert.ok(tones);
  const ordered = Array.from({ length: 25 }, (_, index) => tones.get(index + 1) ?? 0);
  assert.equal(new Set(ordered).size, 25);
  assert.equal(ordered[0], PIANO_TONE_LOW_FREQUENCY);
  assert.equal(ordered.at(-1), PIANO_TONE_LOW_FREQUENCY * 4);
});

test("short rows preserve a pitch for duplicate values and dense rows stay continuous", () => {
  const tones = createSmallArrayPianoToneMap([1, 3, 1, 2]);

  assert.ok(tones);
  assert.equal(tones.size, 3);
  assert.equal(tones.get(1), PIANO_TONE_LOW_FREQUENCY);
  assert.equal(createSmallArrayPianoToneMap(Array.from({ length: 26 }, (_, index) => index + 1)), null);

  const first = getContinuousToneFrequency(2, 256);
  const second = getContinuousToneFrequency(3, 256);
  assert.ok(first > PIANO_TONE_LOW_FREQUENCY);
  assert.ok(second > first);
  assert.notEqual(Math.log2(first / PIANO_TONE_LOW_FREQUENCY) * 12, Math.round(Math.log2(first / PIANO_TONE_LOW_FREQUENCY) * 12));
});
