import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPracticeMove,
  getPracticeTargetScore,
  isPracticeMoveProgress,
} from "../app/lib/practice";

test("a direct block drop swaps values from either starting block", () => {
  assert.deepEqual(applyPracticeMove([1, 2, 3, 4], 0, 2, "swap"), [3, 2, 1, 4]);
  assert.deepEqual(applyPracticeMove([1, 2, 3, 4], 2, 0, "swap"), [3, 2, 1, 4]);
});

test("a between-block drop inserts and shifts values in both directions", () => {
  // Slot indexes describe gaps before the source is removed.
  assert.deepEqual(applyPracticeMove([1, 2, 3, 4], 0, 3, "insert"), [2, 3, 1, 4]);
  assert.deepEqual(applyPracticeMove([1, 2, 3, 4], 3, 1, "insert"), [1, 4, 2, 3]);
});

test("dropping back into the source gap leaves the row unchanged", () => {
  assert.deepEqual(applyPracticeMove([1, 2, 3, 4], 2, 2, "insert"), [1, 2, 3, 4]);
  assert.deepEqual(applyPracticeMove([1, 2, 3, 4], 2, 2, "swap"), [1, 2, 3, 4]);
});

test("a target-order improvement remains valid when position distance ties", () => {
  const target = [1, 2, 3, 4];
  const before = [3, 2, 1, 4];
  const after = [2, 3, 1, 4];

  assert.deepEqual(getPracticeTargetScore(before, target), { inversions: 3, displacement: 4 });
  assert.deepEqual(getPracticeTargetScore(after, target), { inversions: 2, displacement: 4 });
  assert.equal(isPracticeMoveProgress(before, after, target), true);
});

test("position distance breaks ties after relative order", () => {
  const target = [1, 2, 3, 4];
  const before = [4, 1, 2, 3];
  const after = [3, 2, 1, 4];

  assert.equal(getPracticeTargetScore(before, target).inversions, 3);
  assert.equal(getPracticeTargetScore(after, target).inversions, 3);
  assert.equal(isPracticeMoveProgress(before, after, target), true);
});
