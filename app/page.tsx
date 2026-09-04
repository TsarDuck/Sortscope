"use client";

import { useEffect, useMemo, useState } from "react";

type RunState = "ready" | "running" | "paused" | "complete";
type StepPhase = "ready" | "select" | "compare" | "shift" | "insert" | "complete";

type SortStep = {
  values: number[];
  pass: number;
  phase: StepPhase;
  key: number | null;
  comparing: number | null;
  shifting: number | null;
  inserting: number | null;
  gapIndex: number | null;
  sortedCount: number;
  comparisons: number;
  writes: number;
  message: string;
};

const DEFAULT_ARRAY_SIZE = 24;
const DEFAULT_SPEED = 62;
const INITIAL_VALUES = [
  68, 31, 82, 44, 57, 24, 91, 38, 73, 17, 63, 49, 86, 29, 76, 42, 95, 53,
  34, 79, 21, 59, 88, 46,
];

function createInitialStep(values: number[]): SortStep {
  return {
    values: [...values],
    pass: 0,
    phase: "ready",
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: values.length ? 1 : 0,
    comparisons: 0,
    writes: 0,
    message: "The first value starts as a sorted one-item prefix.",
  };
}

function makeRandomArray(length: number) {
  return Array.from({ length }, () => Math.floor(Math.random() * 82) + 14);
}

function buildInsertionSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source)];
  const values = [...source];
  let comparisons = 0;
  let writes = 0;

  for (let i = 1; i < values.length; i += 1) {
    const key = values[i];
    let j = i - 1;

    steps.push({
      values: [...values],
      pass: i,
      phase: "select",
      key,
      comparing: null,
      shifting: null,
      inserting: null,
      gapIndex: null,
      sortedCount: i,
      comparisons,
      writes,
      message: "Pass " + i + ": select " + key + " as the key.",
    });

    while (j >= 0) {
      comparisons += 1;
      steps.push({
        values: [...values],
        pass: i,
        phase: "compare",
        key,
        comparing: j,
        shifting: null,
        inserting: null,
        gapIndex: null,
        sortedCount: i,
        comparisons,
        writes,
        message: "Compare " + key + " with " + values[j] + ".",
      });

      if (values[j] <= key) break;

      values[j + 1] = values[j];
      writes += 1;
      steps.push({
        values: [...values],
        pass: i,
        phase: "shift",
        key,
        comparing: j,
        shifting: j + 1,
        inserting: null,
        gapIndex: j,
        sortedCount: i,
        comparisons,
        writes,
        message: values[j] + " shifts right to make room for " + key + ".",
      });

      j -= 1;
    }

    values[j + 1] = key;
    writes += 1;
    steps.push({
      values: [...values],
      pass: i,
      phase: "insert",
      key,
      comparing: null,
      shifting: null,
      inserting: j + 1,
      gapIndex: null,
      sortedCount: i + 1,
      comparisons,
      writes,
      message: "Insert " + key + " into position " + (j + 1) + ".",
    });
  }

  steps.push({
    values: [...values],
    pass: Math.max(values.length - 1, 0),
    phase: "complete",
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: values.length,
    comparisons,
    writes,
    message: "Every value has found its place.",
  });

  return steps;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

function getBarClass(index: number, step: SortStep) {
  if (index === step.gapIndex) return "bar--gap";
  if (index === step.inserting) return "bar--insert";
  if (index === step.shifting) return "bar--shift";
  if (index === step.comparing) return "bar--compare";
  if (step.phase === "select" && index === step.pass) return "bar--key";
  if (step.phase === "complete" || index < step.sortedCount) return "bar--sorted";
  return "bar--idle";
}

function getPhaseLabel(phase: StepPhase) {
  const labels: Record<StepPhase, string> = {
    ready: "Ready",
    select: "Select key",
    compare: "Compare",
    shift: "Shift right",
    insert: "Insert key",
    complete: "Sorted",
  };

  return labels[phase];
}

export default function Home() {
  const [arraySize, setArraySize] = useState(DEFAULT_ARRAY_SIZE);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [originalValues, setOriginalValues] = useState(INITIAL_VALUES);
  const [values, setValues] = useState(INITIAL_VALUES);
  const [steps, setSteps] = useState<SortStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [runState, setRunState] = useState<RunState>("ready");
  const prefersReducedMotion = usePrefersReducedMotion();

  const currentStep = useMemo(
    () => steps[stepIndex] ?? createInitialStep(values),
    [stepIndex, steps, values],
  );
  const isLocked = runState === "running" || runState === "paused";
  const delay = prefersReducedMotion ? 18 : Math.max(42, 710 - speed * 6.7);
  const progress =
    runState === "complete"
      ? 100
      : Math.round(
          (currentStep.pass / Math.max(1, originalValues.length - 1)) * 100,
        );
  const displayValues = values.join(", ");
  const liveStatus =
    runState === "complete"
      ? "Sorting complete. " + currentStep.comparisons + " comparisons and " + currentStep.writes + " array writes."
      : runState === "paused"
        ? "Paused during pass " + currentStep.pass + " of " + Math.max(originalValues.length - 1, 0) + "."
        : runState === "running"
          ? "Insertion sort is working through pass " + currentStep.pass + " of " + Math.max(originalValues.length - 1, 0) + "."
          : "Ready to demonstrate insertion sort.";

  useEffect(() => {
    if (runState !== "running" || steps.length === 0) return;

    const timer = window.setTimeout(() => {
      const nextIndex = stepIndex + 1;
      if (nextIndex >= steps.length) {
        setRunState("complete");
        return;
      }

      setStepIndex(nextIndex);
      setValues(steps[nextIndex].values);
      if (nextIndex === steps.length - 1) {
        setRunState("complete");
      }
    }, delay);

    return () => window.clearTimeout(timer);
  }, [delay, runState, stepIndex, steps]);

  function createNewArray(size = arraySize) {
    const nextValues = makeRandomArray(size);
    setOriginalValues(nextValues);
    setValues(nextValues);
    setSteps([]);
    setStepIndex(0);
    setRunState("ready");
  }

  function resetArray() {
    setValues([...originalValues]);
    setSteps([]);
    setStepIndex(0);
    setRunState("ready");
  }

  function handlePrimaryAction() {
    if (runState === "running") {
      setRunState("paused");
      return;
    }

    if (runState === "paused") {
      setRunState("running");
      return;
    }

    const sequence = buildInsertionSteps(originalValues);
    setValues([...originalValues]);
    setSteps(sequence);
    setStepIndex(0);
    setRunState(sequence.length > 1 ? "running" : "complete");
  }

  function handleArraySizeChange(nextSize: number) {
    setArraySize(nextSize);
    createNewArray(nextSize);
  }

  const primaryLabel =
    runState === "running"
      ? "Pause"
      : runState === "paused"
        ? "Resume"
        : runState === "complete"
          ? "Replay sort"
          : "Start sorting";

  return (
    <main className="sortlab-app">
      <div className="page-glow page-glow--one" aria-hidden="true" />
      <div className="page-glow page-glow--two" aria-hidden="true" />

      <div className="shell">
        <header className="site-header">
          <a className="brand" href="#visualizer" aria-label="Sortscope visualizer">
            <span className="brand-mark" aria-hidden="true" />
            <span>sortscope</span>
          </a>
          <div className="header-note">
            <span className="header-note__dot" aria-hidden="true" />
            algorithm study tool
          </div>
        </header>

        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">SORTING, MADE VISIBLE</p>
            <h1 id="page-title">
              Watch each value
              <span> find its place.</span>
            </h1>
            <p className="hero-copy">
              Slow down a real insertion sort and see the sorted prefix grow one
              deliberate move at a time.
            </p>
          </div>
          <div className="hero-aside">
            <span className="hero-aside__number">01</span>
            <div>
              <p>NOW EXPLORING</p>
              <strong>Insertion sort</strong>
            </div>
          </div>
        </section>

        <section id="visualizer" className="visualizer" aria-labelledby="visualizer-title">
          <div className="control-deck">
            <div className="control-deck__intro">
              <p className="eyebrow">CONTROL ROOM</p>
              <h2 id="visualizer-title">Build a sorted prefix</h2>
            </div>

            <div className="controls" aria-label="Visualizer controls">
              <label className="control-field control-field--algorithm">
                <span className="control-label">Algorithm</span>
                <select defaultValue="insertion" aria-label="Sorting algorithm">
                  <option value="insertion">Insertion sort</option>
                </select>
              </label>

              <label className="control-field control-field--range">
                <span className="control-label">
                  Array size <strong>{arraySize}</strong>
                </span>
                <input
                  type="range"
                  min="8"
                  max="36"
                  value={arraySize}
                  onChange={(event) => handleArraySizeChange(Number(event.target.value))}
                  disabled={isLocked}
                  aria-label="Array size"
                />
              </label>

              <label className="control-field control-field--range">
                <span className="control-label">
                  Speed <strong>{prefersReducedMotion ? "instant" : String(speed) + "%"}</strong>
                </span>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                  aria-label="Animation speed"
                />
              </label>

              <div className="button-row">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => createNewArray()}
                  disabled={isLocked}
                >
                  New array
                </button>
                <button className="button button--primary" type="button" onClick={handlePrimaryAction}>
                  <span className={"button-pulse " + (runState === "running" ? "button-pulse--active" : "")} aria-hidden="true" />
                  {primaryLabel}
                </button>
                <button className="text-button" type="button" onClick={resetArray}>
                  Reset
                </button>
              </div>
            </div>
          </div>

          <div className="workbench">
            <div className="workbench__topline">
              <div>
                <p className="workbench__overline">LIVE ARRAY</p>
                <p className="workbench__message">{currentStep.message}</p>
              </div>
              <div className={"phase-chip phase-chip--" + currentStep.phase}>
                <span aria-hidden="true" />
                {getPhaseLabel(currentStep.phase)}
              </div>
            </div>

            <div className="chart-stage" role="img" aria-label={"Array values: " + displayValues + ". " + currentStep.message}>
              <div className="chart-grid" aria-hidden="true" />
              {currentStep.phase === "shift" && currentStep.key !== null && (
                <div className="held-key" aria-hidden="true">
                  <span>holding key</span>
                  <strong>{currentStep.key}</strong>
                </div>
              )}
              <div className="bars" aria-hidden="true">
                {values.map((value, index) => {
                  const isGap = index === currentStep.gapIndex;
                  const shownValue = isGap && currentStep.key !== null ? currentStep.key : value;
                  const height = Math.max(13, Math.round((shownValue / 100) * 100));
                  return (
                    <div className="bar-slot" key={String(index) + "-" + String(originalValues.length)}>
                      <div
                        className={"bar " + getBarClass(index, currentStep)}
                        style={{ height: String(height) + "%" }}
                      >
                        {arraySize <= 24 && (
                          <span className="bar__value">{isGap ? "gap" : value}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="axis-labels" aria-hidden="true">
                <span>lower values</span>
                <span>higher values</span>
              </div>
            </div>

            <div className="workbench__footer">
              <div className="legend" aria-label="Color legend">
                <span><i className="legend__swatch legend__swatch--idle" />unsorted</span>
                <span><i className="legend__swatch legend__swatch--sorted" />sorted prefix</span>
                <span><i className="legend__swatch legend__swatch--key" />active key</span>
                <span><i className="legend__swatch legend__swatch--compare" />comparison</span>
              </div>
              <div className="motion-note">
                {prefersReducedMotion ? "Reduced motion is on" : "Adjustable speed"}
              </div>
            </div>
          </div>

          <div className="stats" aria-label="Sort statistics">
            <div className="stat-card">
              <span>PASS</span>
              <strong>{currentStep.pass}<em> / {Math.max(originalValues.length - 1, 0)}</em></strong>
              <p>key placement</p>
            </div>
            <div className="stat-card">
              <span>COMPARISONS</span>
              <strong>{currentStep.comparisons}</strong>
              <p>values checked</p>
            </div>
            <div className="stat-card">
              <span>ARRAY WRITES</span>
              <strong>{currentStep.writes}</strong>
              <p>shifts + inserts</p>
            </div>
            <div className="stat-card stat-card--progress">
              <span>PROGRESS</span>
              <strong>{progress}<em>%</em></strong>
              <div className="progress-track" aria-hidden="true"><i style={{ width: String(progress) + "%" }} /></div>
            </div>
          </div>
        </section>

        <section className="learn-grid" aria-labelledby="learn-title">
          <div className="learn-copy">
            <p className="eyebrow">THE BIG IDEA</p>
            <h2 id="learn-title">Like sorting cards in your hand.</h2>
            <p>
              Insertion sort grows a tidy section from left to right. It picks
              up one value, shifts larger neighbors aside, then drops that value
              into the gap it created.
            </p>
            <div className="complexity-row" aria-label="Insertion sort complexity">
              <span><b>BEST</b> O(n)</span>
              <span><b>AVERAGE</b> O(n²)</span>
              <span><b>SPACE</b> O(1)</span>
            </div>
          </div>

          <div className="algorithm-card">
            <div className="algorithm-card__header">
              <span>INSERTION SORT</span>
              <span>stable · in-place</span>
            </div>
            <ol className="algorithm-steps">
              <li><i>01</i><span>Choose the next value as the <b>key</b>.</span></li>
              <li><i>02</i><span>Compare it to values in the sorted prefix.</span></li>
              <li><i>03</i><span>Shift larger values right, then insert the key.</span></li>
            </ol>
          </div>
        </section>

        <p className="sr-only" aria-live="polite" aria-atomic="true">{liveStatus}</p>
      </div>
    </main>
  );
}
