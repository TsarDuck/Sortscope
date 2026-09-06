import type { BogoSession } from "./sorting";

// Keep the worker boundary deliberately small and structured-clone-safe. The
// worker owns the mutable session between snapshots; the page only receives
// ordinary BogoSession copies for rendering, controls, and rate reporting.
export type BogoWorkerPacing = {
  attemptDelayMs: number;
  batchBudgetMs: number;
  snapshotIntervalMs: number;
};

export type BogoWorkerCommand =
  | {
      type: "start";
      runId: number;
      session: BogoSession;
      pacing: BogoWorkerPacing;
    }
  | {
      type: "configure";
      runId: number;
      configurationId: number;
      pacing: BogoWorkerPacing;
    }
  | { type: "pause"; runId: number }
  | { type: "resume"; runId: number }
  | { type: "cancel"; runId: number };

export type BogoWorkerEvent =
  | { type: "ready" }
  | { type: "snapshot"; runId: number; session: BogoSession }
  | {
      type: "configured";
      runId: number;
      configurationId: number;
      session: BogoSession;
    }
  | { type: "paused"; runId: number; session: BogoSession }
  | { type: "complete"; runId: number; session: BogoSession }
  | { type: "error"; runId: number; message: string; session?: BogoSession };
