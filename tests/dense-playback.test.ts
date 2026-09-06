import assert from "node:assert/strict";
import test from "node:test";
import {
  DENSE_CANVAS_MAX_CATCH_UP_ADVANCES_PER_FRAME,
  advanceDensePlaybackTimeline,
  createDenseCanvasPresentationState,
  recordDenseCanvasAnimationFrame,
  shouldPresentDenseCanvasFrame,
} from "../app/lib/dense-playback";

test("dense Canvas presents every host frame when the host sustains a high refresh rate", () => {
  const state = createDenseCanvasPresentationState();
  let timestamp = 0;

  for (let frame = 0; frame < 48; frame += 1) {
    recordDenseCanvasAnimationFrame(state, timestamp);
    assert.equal(shouldPresentDenseCanvasFrame(state, timestamp), true);
    timestamp += 1_000 / 240;
  }

  assert.equal(state.minimumPresentationInterval, 0);
});

test("dense Canvas degrades only after sustained slow frames and recovers at native cadence", () => {
  const state = createDenseCanvasPresentationState();
  let timestamp = 0;
  recordDenseCanvasAnimationFrame(state, timestamp);
  shouldPresentDenseCanvasFrame(state, timestamp);

  for (let frame = 0; frame < 4; frame += 1) {
    timestamp += 28;
    recordDenseCanvasAnimationFrame(state, timestamp);
  }

  assert.ok(state.minimumPresentationInterval > 0);
  assert.equal(shouldPresentDenseCanvasFrame(state, timestamp), true);
  assert.equal(
    shouldPresentDenseCanvasFrame(
      state,
      timestamp + state.minimumPresentationInterval - 1,
    ),
    false,
  );
  assert.equal(
    shouldPresentDenseCanvasFrame(
      state,
      timestamp + state.minimumPresentationInterval,
    ),
    true,
  );

  for (let frame = 0; frame < 24; frame += 1) {
    timestamp += 16;
    recordDenseCanvasAnimationFrame(state, timestamp);
  }

  assert.equal(state.minimumPresentationInterval, 0);
  assert.equal(shouldPresentDenseCanvasFrame(state, timestamp), true);
});

test("dense playback bounds an overdue rAF catch-up without imposing a normal frame cap", () => {
  assert.ok(DENSE_CANVAS_MAX_CATCH_UP_ADVANCES_PER_FRAME > 0);
  assert.ok(DENSE_CANVAS_MAX_CATCH_UP_ADVANCES_PER_FRAME <= 64);

  const firstCatchUp = advanceDensePlaybackTimeline({
    currentStepIndex: 0,
    finalStepIndex: 10_000,
    lastAdvanceAt: 0,
    now: 10_000,
    getPlaybackTiming: () => ({ stepDelay: 4, stepStride: 1 }),
  });
  assert.equal(firstCatchUp.advances, DENSE_CANVAS_MAX_CATCH_UP_ADVANCES_PER_FRAME);
  assert.equal(firstCatchUp.stepIndex, DENSE_CANVAS_MAX_CATCH_UP_ADVANCES_PER_FRAME);

  const secondCatchUp = advanceDensePlaybackTimeline({
    currentStepIndex: firstCatchUp.stepIndex,
    finalStepIndex: 10_000,
    lastAdvanceAt: firstCatchUp.lastAdvanceAt,
    now: 10_000,
    getPlaybackTiming: () => ({ stepDelay: 4, stepStride: 1 }),
  });
  assert.equal(secondCatchUp.stepIndex, DENSE_CANVAS_MAX_CATCH_UP_ADVANCES_PER_FRAME * 2);
});

test("dense playback advances by elapsed time rather than the display refresh rate", () => {
  const runForOneSecond = (frameInterval: number) => {
    let stepIndex = 0;
    let lastAdvanceAt = 0;

    const frameCount = Math.round(1_000 / frameInterval);
    for (let frame = 1; frame <= frameCount; frame += 1) {
      const now = Math.min(1_000, frame * frameInterval);
      const result = advanceDensePlaybackTimeline({
        currentStepIndex: stepIndex,
        finalStepIndex: 1_000,
        lastAdvanceAt,
        now,
        getPlaybackTiming: () => ({ stepDelay: 4, stepStride: 1 }),
      });
      stepIndex = result.stepIndex;
      lastAdvanceAt = result.lastAdvanceAt;
    }

    return stepIndex;
  };

  // A 4 ms max-speed schedule should progress by the same elapsed amount on
  // 60 Hz and 240 Hz displays; only the paint opportunities differ.
  assert.equal(runForOneSecond(1_000 / 60), 250);
  assert.equal(runForOneSecond(1_000 / 240), 250);
});
