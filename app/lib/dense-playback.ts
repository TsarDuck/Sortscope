// A dense Canvas frame has no reason to be limited to a fixed FPS: the host
// already schedules requestAnimationFrame at the display's actual refresh
// rate. These small, ref-friendly helpers keep that policy while letting a
// struggling WebView temporarily present less often to recover.

export const DENSE_CANVAS_MAX_CATCH_UP_ADVANCES_PER_FRAME = 48;

const SLOW_FRAME_THRESHOLD_MS = 22;
const SLOW_FRAME_STREAK_TO_DEGRADE = 4;
const RECOVERY_FRAME_THRESHOLD_MS = 18;
const RECOVERY_FRAME_STREAK_TO_RECOVER = 24;
const DEGRADED_PRESENTATION_INTERVAL_MS = 32;

export type DenseCanvasPresentationState = {
  lastAnimationFrameAt: number | null;
  lastPresentationAt: number | null;
  slowFrameStreak: number;
  recoveryFrameStreak: number;
  minimumPresentationInterval: number;
};

export type DensePlaybackTiming = {
  stepDelay: number;
  stepStride: number;
};

export type DensePlaybackAdvance = {
  stepIndex: number;
  lastAdvanceAt: number;
  advances: number;
};

export function createDenseCanvasPresentationState(): DenseCanvasPresentationState {
  return {
    lastAnimationFrameAt: null,
    lastPresentationAt: null,
    slowFrameStreak: 0,
    recoveryFrameStreak: 0,
    minimumPresentationInterval: 0,
  };
}

/**
 * Advance a recorded sorting trace by elapsed time, not by render count. The
 * caller supplies the timing for each local step so merge passes can retain
 * their own pacing policy. A bounded catch-up prevents a delayed rAF from
 * becoming a self-reinforcing long task.
 */
export function advanceDensePlaybackTimeline({
  currentStepIndex,
  finalStepIndex,
  lastAdvanceAt,
  now,
  getPlaybackTiming,
}: {
  currentStepIndex: number;
  finalStepIndex: number;
  lastAdvanceAt: number;
  now: number;
  getPlaybackTiming: (stepIndex: number) => DensePlaybackTiming;
}): DensePlaybackAdvance {
  let nextStepIndex = currentStepIndex;
  let nextAdvanceAt = lastAdvanceAt;
  let elapsed = Math.max(0, now - nextAdvanceAt);
  let advances = 0;

  while (
    nextStepIndex < finalStepIndex &&
    advances < DENSE_CANVAS_MAX_CATCH_UP_ADVANCES_PER_FRAME
  ) {
    const timing = getPlaybackTiming(nextStepIndex);
    const nextDelay = Math.max(1, timing.stepDelay);
    if (elapsed < nextDelay) break;

    elapsed -= nextDelay;
    nextAdvanceAt += nextDelay;
    nextStepIndex = Math.min(
      finalStepIndex,
      nextStepIndex + Math.max(1, timing.stepStride),
    );
    advances += 1;
  }

  return {
    stepIndex: nextStepIndex,
    lastAdvanceAt: nextAdvanceAt,
    advances,
  };
}

/**
 * Observe the host's actual animation-frame cadence. This never controls the
 * sorting timeline; it only decides whether a newly due snapshot is painted
 * immediately or coalesced into the next presentation frame.
 */
export function recordDenseCanvasAnimationFrame(
  state: DenseCanvasPresentationState,
  timestamp: number,
) {
  const previousTimestamp = state.lastAnimationFrameAt;
  state.lastAnimationFrameAt = timestamp;
  if (previousTimestamp === null) return;

  const interval = Math.max(0, timestamp - previousTimestamp);
  if (interval >= SLOW_FRAME_THRESHOLD_MS) {
    state.slowFrameStreak = Math.min(
      SLOW_FRAME_STREAK_TO_DEGRADE,
      state.slowFrameStreak + 1,
    );
    state.recoveryFrameStreak = 0;
    if (state.slowFrameStreak >= SLOW_FRAME_STREAK_TO_DEGRADE) {
      state.minimumPresentationInterval = DEGRADED_PRESENTATION_INTERVAL_MS;
    }
    return;
  }

  state.slowFrameStreak = Math.max(0, state.slowFrameStreak - 1);
  if (
    state.minimumPresentationInterval > 0 &&
    interval <= RECOVERY_FRAME_THRESHOLD_MS
  ) {
    state.recoveryFrameStreak = Math.min(
      RECOVERY_FRAME_STREAK_TO_RECOVER,
      state.recoveryFrameStreak + 1,
    );
    if (state.recoveryFrameStreak >= RECOVERY_FRAME_STREAK_TO_RECOVER) {
      state.minimumPresentationInterval = 0;
      state.recoveryFrameStreak = 0;
    }
    return;
  }

  state.recoveryFrameStreak = 0;
}

/**
 * Mark a paint when the host can sustain native refresh. During sustained slow
 * frames this limits Canvas work, but a terminal frame is always presented so
 * the final state cannot be skipped.
 */
export function shouldPresentDenseCanvasFrame(
  state: DenseCanvasPresentationState,
  timestamp: number,
  force = false,
) {
  if (
    force ||
    state.minimumPresentationInterval === 0 ||
    state.lastPresentationAt === null ||
    timestamp - state.lastPresentationAt >= state.minimumPresentationInterval
  ) {
    state.lastPresentationAt = timestamp;
    return true;
  }

  return false;
}
