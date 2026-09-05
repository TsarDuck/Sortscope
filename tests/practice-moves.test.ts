import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPracticeMove,
  getPracticeTargetScore,
  isPracticeRowFinished,
  isPracticeMoveProgress,
  resolvePracticeDropTarget,
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

test("a fully ordered practice row must still be the lesson's original permutation", () => {
  const lessonValues = [1, 2, 3, 4, 5, 6];

  assert.equal(isPracticeRowFinished([1, 2, 3, 4, 5, 6], lessonValues), true);
  assert.equal(isPracticeRowFinished([1, 2, 3, 4, 5, 7], lessonValues), false);
  assert.equal(isPracticeRowFinished([1, 2, 2, 4, 5, 6], lessonValues), false);
  assert.equal(isPracticeRowFinished([1, 3, 2, 4, 5, 6], lessonValues), false);
});

test("a finished Heap row passes the global completion guard", () => {
  // Heap's final extraction swaps the active root 3 directly with 1.
  // The completion check must recognize the ordered row before any old
  // per-step checker could hold the lesson open.
  const lessonValues = [1, 2, 3, 4, 5, 6];
  const finishedShortcut = applyPracticeMove([3, 2, 1, 4, 5, 6], 0, 2, "swap");

  assert.deepEqual(finishedShortcut, [1, 2, 3, 4, 5, 6]);
  assert.equal(isPracticeRowFinished(finishedShortcut, lessonValues), true);
});

test("one shared drop resolver distinguishes direct swaps from between-block inserts", () => {
  const blocks = [
    { index: 0, left: 20, right: 68, top: 20, bottom: 68 },
    { index: 1, left: 92, right: 140, top: 20, bottom: 68 },
    { index: 2, left: 164, right: 212, top: 20, bottom: 68 },
  ];
  const gaps = [
    { index: 0, left: 5, right: 12, top: 20, bottom: 68 },
    { index: 1, left: 77, right: 84, top: 20, bottom: 68 },
    { index: 2, left: 149, right: 156, top: 20, bottom: 68 },
    { index: 3, left: 221, right: 228, top: 20, bottom: 68 },
  ];

  assert.deepEqual(resolvePracticeDropTarget(108, 44, 0, blocks, gaps), {
    index: 1,
    mode: "swap",
  });
  assert.deepEqual(resolvePracticeDropTarget(80, 44, 0, blocks, gaps), {
    index: 1,
    mode: "insert",
  });
  assert.deepEqual(resolvePracticeDropTarget(88, 44, 0, blocks, gaps), {
    index: 1,
    mode: "swap",
  });
});

test("the floating source never becomes its own direct drop target", () => {
  const blocks = [
    { index: 0, left: 20, right: 68, top: 20, bottom: 68 },
    { index: 1, left: 92, right: 140, top: 20, bottom: 68 },
  ];
  const gaps = [
    { index: 0, left: 5, right: 12, top: 20, bottom: 68 },
    { index: 1, left: 77, right: 84, top: 20, bottom: 68 },
    { index: 2, left: 149, right: 156, top: 20, bottom: 68 },
  ];

  assert.equal(resolvePracticeDropTarget(44, 44, 0, blocks, gaps, blocks[0]), null);
});

test("the shared move mechanics preserve every lesson's 6-to-12 block rows", () => {
  for (const size of [6, 8, 10, 12]) {
    const values = Array.from({ length: size }, (_, index) => index + 1);
    const swapped = applyPracticeMove(values, 0, size - 1, "swap");
    const inserted = applyPracticeMove(values, 0, size, "insert");

    assert.deepEqual([...swapped].sort((left, right) => left - right), values);
    assert.deepEqual([...inserted].sort((left, right) => left - right), values);
    assert.equal(swapped[0], size);
    assert.equal(inserted[size - 1], 1);
  }
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
