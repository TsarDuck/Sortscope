import { advanceBogoSession, type BogoSession } from "./sorting";
import type {
  BogoWorkerCommand,
  BogoWorkerEvent,
  BogoWorkerPacing,
} from "./bogo-worker-protocol";

// `tsconfig` also includes the DOM library, so use an explicit minimal worker
// shape instead of declaring `self` as DedicatedWorkerGlobalScope. Vite still
// emits this file as a native module worker from the static `new URL()` call in
// page.tsx.
type BogoWorkerScope = {
  onmessage: ((event: MessageEvent<BogoWorkerCommand>) => void) | null;
  postMessage: (message: BogoWorkerEvent) => void;
};

type ActiveBogoWorkerRun = {
  runId: number;
  session: BogoSession;
  pacing: BogoWorkerPacing;
  running: boolean;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
  fastPumpQueued: boolean;
  lastSnapshotAt: number;
};

const workerScope = globalThis as unknown as BogoWorkerScope;
let activeRun: ActiveBogoWorkerRun | null = null;

// Nested zero-delay timers are aggressively clamped in WebKit workers, which
// turns an otherwise fast Bogo loop into repeated idle gaps. A MessagePort
// queues a normal task without that clamp: it still lets incoming pause/reset
// commands run between the short batches, but keeps the simulation on a CPU
// core rather than pacing it through the UI timer queue.
const fastPumpChannel = new MessageChannel();
fastPumpChannel.port1.onmessage = (event: MessageEvent<number>) => {
  const run = activeRun;
  if (run && run.runId === event.data) run.fastPumpQueued = false;
  if (
    !run ||
    run.runId !== event.data ||
    !run.running ||
    run.pacing.attemptDelayMs > 0
  ) {
    return;
  }
  pump(run);
};

function clearRunTimer(run: ActiveBogoWorkerRun) {
  if (run.timer === null) return;
  globalThis.clearTimeout(run.timer);
  run.timer = null;
}

function emit(
  type: Extract<BogoWorkerEvent["type"], "snapshot" | "paused" | "complete">,
  run: ActiveBogoWorkerRun,
) {
  // postMessage structured-clones this tiny n<=25 session. Do not transfer its
  // values buffer: the worker must keep mutating its own copy after a snapshot.
  workerScope.postMessage({ type, runId: run.runId, session: run.session });
}

function schedule(run: ActiveBogoWorkerRun) {
  if (activeRun !== run || !run.running || run.session.done) return;

  const delay = Math.max(0, Math.round(run.pacing.attemptDelayMs));
  if (delay === 0) {
    if (run.fastPumpQueued) return;
    run.fastPumpQueued = true;
    fastPumpChannel.port2.postMessage(run.runId);
    return;
  }
  run.timer = globalThis.setTimeout(() => pump(run), delay);
}

function pump(run: ActiveBogoWorkerRun) {
  run.timer = null;
  if (activeRun !== run || !run.running) return;

  try {
    if (run.pacing.attemptDelayMs > 0) {
      advanceBogoSession(run.session);
    } else {
      const deadline = performance.now() + Math.max(1, run.pacing.batchBudgetMs);
      do {
        advanceBogoSession(run.session);
      } while (!run.session.done && performance.now() < deadline);
    }

    const now = performance.now();
    if (run.session.done) {
      run.running = false;
      emit("complete", run);
      return;
    }

    if (now - run.lastSnapshotAt >= Math.max(1, run.pacing.snapshotIntervalMs)) {
      run.lastSnapshotAt = now;
      emit("snapshot", run);
    }

    schedule(run);
  } catch (error) {
    run.running = false;
    workerScope.postMessage({
      type: "error",
      runId: run.runId,
      message: error instanceof Error ? error.message : "Bogo worker stopped unexpectedly.",
      session: run.session,
    });
  }
}

workerScope.onmessage = (event) => {
  const command = event.data;

  if (command.type === "start") {
    if (activeRun) clearRunTimer(activeRun);
    const run: ActiveBogoWorkerRun = {
      runId: command.runId,
      session: command.session,
      pacing: command.pacing,
      running: true,
      timer: null,
      fastPumpQueued: false,
      lastSnapshotAt: performance.now(),
    };
    activeRun = run;
    // Confirm both the worker handshake and the exact initial session before
    // the first fast batch gets a chance to mutate it.
    emit("snapshot", run);
    schedule(run);
    return;
  }

  const run = activeRun;
  if (!run || command.runId !== run.runId) return;

  if (command.type === "configure") {
    const wasRunning = run.running;
    clearRunTimer(run);
    run.pacing = command.pacing;
    workerScope.postMessage({
      type: "configured",
      runId: run.runId,
      configurationId: command.configurationId,
      session: run.session,
    });
    if (wasRunning) schedule(run);
    return;
  }

  if (command.type === "pause") {
    run.running = false;
    clearRunTimer(run);
    emit("paused", run);
    return;
  }

  if (command.type === "resume") {
    if (!run.session.done && !run.running) {
      run.running = true;
      schedule(run);
    }
    return;
  }

  clearRunTimer(run);
  activeRun = null;
};

workerScope.postMessage({ type: "ready" });
