"use client";

import { useEffect, useMemo, useState } from "react";
import {
  analyzeInsertionSort,
  analyzeMeanPartitionSort,
  buildMeanPartitionSteps,
  formatMean,
} from "./lib/sorting";

type AlgorithmId = "insertion" | "mean-partition";
type RunState = "ready" | "running" | "paused" | "complete";
type StepPhase =
  | "ready"
  | "select"
  | "compare"
  | "shift"
  | "insert"
  | "split"
  | "average"
  | "reorder"
  | "complete";

type MeanGroup = {
  id: number;
  start: number;
  end: number;
  mean: number;
  rank: number;
};

type BenchmarkPattern = "random" | "reverse" | "nearly-sorted";

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
  groups?: MeanGroup[];
};

const DEFAULT_ARRAY_SIZE = 24;
const DEFAULT_SPEED = 62;
const BENCHMARK_SIZES = [16, 32, 64, 128, 256];
const INITIAL_VALUES = [
  17, 5, 22, 8, 19, 3, 14, 24, 1, 12, 7, 20, 10, 23, 4, 16, 9, 21, 2, 18,
  6, 15, 11, 13,
];

function createInitialStep(
  values: number[],
  algorithm: AlgorithmId = "insertion",
): SortStep {
  const isMeanPartition = algorithm === "mean-partition";

  return {
    values: [...values],
    pass: 0,
    phase: "ready",
    key: null,
    comparing: null,
    shifting: null,
    inserting: null,
    gapIndex: null,
    sortedCount: isMeanPartition ? 0 : values.length ? 1 : 0,
    comparisons: 0,
    writes: 0,
    message: isMeanPartition
      ? values.length <= 1
        ? "One value is already ordered."
        : "The row will be repeatedly split into mean-ranked groups."
      : "The first value starts as a sorted one-item prefix.",
  };
}

function makeRandomArray(length: number) {
  const values = Array.from({ length }, (_, index) => index + 1);

  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }

  return values;
}

function makeBenchmarkArray(length: number, pattern: BenchmarkPattern) {
  const values = Array.from({ length }, (_, index) => index + 1);

  if (pattern === "reverse") {
    return values.reverse();
  }

  if (pattern === "nearly-sorted") {
    const swapCount = Math.max(2, Math.floor(length * 0.08));
    for (let index = 0; index < swapCount; index += 1) {
      const left = (index * 17 + 3) % length;
      const right = (index * 29 + 7) % length;
      [values[left], values[right]] = [values[right], values[left]];
    }
    return values;
  }

  let seed = length * 7919 + 17;
  for (let index = values.length - 1; index > 0; index -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const swapIndex = seed % (index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }

  return values;
}

function formatCount(value: number) {
  return value.toLocaleString("en-US");
}

function buildInsertionSteps(source: number[]): SortStep[] {
  const steps = [createInitialStep(source)];
  const values = [...source];
  let comparisons = 0;
  let writes = 0;
  const useCompactFrames = values.length > 64;

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
      if (!useCompactFrames) {
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
      }

      if (values[j] <= key) break;

      values[j + 1] = values[j];
      writes += 1;
      if (!useCompactFrames) {
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
      }

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

function getBarClass(
  index: number,
  step: SortStep,
  algorithm: AlgorithmId,
) {
  if (algorithm === "mean-partition") {
    if (step.phase === "complete") return "bar--sorted";
    if (step.phase === "split") return "bar--partition";
    if (step.phase === "average") return "bar--mean";
    if (step.phase === "reorder") return "bar--rank";
    return "bar--idle";
  }

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
    split: "Split groups",
    average: "Measure means",
    reorder: "Rank groups",
    complete: "Sorted",
  };

  return labels[phase];
}

export default function Home() {
  const [algorithm, setAlgorithm] = useState<AlgorithmId>("insertion");
  const [arraySize, setArraySize] = useState(DEFAULT_ARRAY_SIZE);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [benchmarkPattern, setBenchmarkPattern] =
    useState<BenchmarkPattern>("random");
  const [originalValues, setOriginalValues] = useState(INITIAL_VALUES);
  const [values, setValues] = useState(INITIAL_VALUES);
  const [steps, setSteps] = useState<SortStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [runState, setRunState] = useState<RunState>("ready");
  const prefersReducedMotion = usePrefersReducedMotion();
  const isMeanPartition = algorithm === "mean-partition";
  const algorithmLabel = isMeanPartition
    ? "Mean partition sort"
    : "Insertion sort";
  const stageLabel = isMeanPartition ? "round" : "pass";
  const totalStages = isMeanPartition
    ? Math.max(1, Math.ceil(Math.log2(Math.max(originalValues.length, 1))))
    : Math.max(originalValues.length - 1, 0);
  const benchmarkData = useMemo(
    () =>
      BENCHMARK_SIZES.map((size) => {
        const benchmarkValues = makeBenchmarkArray(size, benchmarkPattern);
        const insertion = analyzeInsertionSort(benchmarkValues);
        const meanPartition = analyzeMeanPartitionSort(benchmarkValues);

        return {
          size,
          insertionWork: insertion.comparisons + insertion.writes,
          meanWork:
            meanPartition.comparisons +
            meanPartition.rankComparisons +
            meanPartition.writes,
        };
      }),
    [benchmarkPattern],
  );
  const benchmarkMaximum = Math.max(
    1,
    ...benchmarkData.flatMap((entry) => [entry.insertionWork, entry.meanWork]),
  );
  const selectedBenchmark = useMemo(() => {
    const benchmarkValues = makeBenchmarkArray(arraySize, benchmarkPattern);
    const insertion = analyzeInsertionSort(benchmarkValues);
    const meanPartition = analyzeMeanPartitionSort(benchmarkValues);

    return {
      insertion: insertion.comparisons + insertion.writes,
      meanPartition:
        meanPartition.comparisons +
        meanPartition.rankComparisons +
        meanPartition.writes,
    };
  }, [arraySize, benchmarkPattern]);

  const currentStep = useMemo(
    () => steps[stepIndex] ?? createInitialStep(values, algorithm),
    [algorithm, stepIndex, steps, values],
  );
  const isLocked = runState === "running" || runState === "paused";
  const playbackDensity = isMeanPartition
    ? 1
    : Math.max(1, Math.ceil(originalValues.length / 48));
  const delay = prefersReducedMotion
    ? 18
    : Math.max(7, (710 - speed * 6.7) / playbackDensity);
  const progress =
    runState === "complete"
      ? 100
      : Math.round(
          (currentStep.pass / Math.max(1, totalStages)) * 100,
        );
  const displayValues = values.join(", ");
  const largestValue = Math.max(...originalValues, 1);
  const liveStatus =
    runState === "complete"
      ? isMeanPartition
        ? "Sorting complete. " + currentStep.comparisons + " group means and " + currentStep.writes + " moved values."
        : "Sorting complete. " + currentStep.comparisons + " comparisons and " + currentStep.writes + " array writes."
      : runState === "paused"
        ? "Paused during " + stageLabel + " " + currentStep.pass + " of " + totalStages + "."
        : runState === "running"
          ? algorithmLabel + " is working through " + stageLabel + " " + currentStep.pass + " of " + totalStages + "."
          : "Ready to demonstrate " + algorithmLabel + ".";

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

  function handleAlgorithmChange(nextAlgorithm: AlgorithmId) {
    setAlgorithm(nextAlgorithm);
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

    const sequence = isMeanPartition
      ? buildMeanPartitionSteps(originalValues)
      : buildInsertionSteps(originalValues);
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
              {isMeanPartition
                ? "Split the newly arranged row into 2, 4, 8, and more balanced groups, then rank every group by its average."
                : "Slow down a real insertion sort and see the sorted prefix grow one deliberate move at a time."}
            </p>
          </div>
          <div className="hero-aside">
            <span className="hero-aside__number">{isMeanPartition ? "02" : "01"}</span>
            <div>
              <p>NOW EXPLORING</p>
              <strong>{algorithmLabel}</strong>
            </div>
          </div>
        </section>

        <section id="visualizer" className="visualizer" aria-labelledby="visualizer-title">
          <div className="control-deck">
            <div className="control-deck__intro">
              <p className="eyebrow">CONTROL ROOM</p>
              <h2 id="visualizer-title">
                {isMeanPartition ? "Rank groups by their mean" : "Build a sorted prefix"}
              </h2>
            </div>

            <div className="controls" aria-label="Visualizer controls">
              <label className="control-field control-field--algorithm">
                <span className="control-label">Algorithm</span>
                <select
                  value={algorithm}
                  onChange={(event) => handleAlgorithmChange(event.target.value as AlgorithmId)}
                  disabled={isLocked}
                  aria-label="Sorting algorithm"
                >
                  <option value="insertion">Insertion sort</option>
                  <option value="mean-partition">Mean partition sort (experiment)</option>
                </select>
              </label>

              <label className="control-field control-field--range">
                <span className="control-label">
                  Array size <strong>{arraySize}</strong>
                </span>
                <input
                  type="range"
                  min="8"
                  max="256"
                  step="1"
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
              {isMeanPartition && currentStep.groups && (
                <div className="mean-bands" aria-hidden="true">
                  {currentStep.groups.map((group) => {
                    const left = (group.start / Math.max(values.length, 1)) * 100;
                    const width =
                      ((group.end - group.start) / Math.max(values.length, 1)) * 100;
                    return (
                      <div
                        className="mean-band"
                        key={String(group.id) + "-" + String(group.rank)}
                        style={{ left: String(left) + "%", width: String(width) + "%" }}
                      >
                        {currentStep.groups && currentStep.groups.length <= 8 && (
                          <span>μ {formatMean(group.mean)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {!isMeanPartition && currentStep.phase === "shift" && currentStep.key !== null && (
                <div className="held-key" aria-hidden="true">
                  <span>holding key</span>
                  <strong>{currentStep.key}</strong>
                </div>
              )}
              <div className={"bars " + (originalValues.length > 64 ? "bars--dense" : "")} aria-hidden="true">
                {values.map((value, index) => {
                  const isGap = index === currentStep.gapIndex;
                  const shownValue = isGap && currentStep.key !== null ? currentStep.key : value;
                  const group = isMeanPartition
                    ? currentStep.groups?.find(
                        (candidate) => index >= candidate.start && index < candidate.end,
                      )
                    : undefined;
                  const groupClass = group
                    ? (index === group.start ? "bar-slot--group-start " : "") +
                      (index === group.end - 1 ? "bar-slot--group-end" : "")
                    : "";
                  const height = Math.max(
                    3,
                    Math.round((shownValue / largestValue) * 100),
                  );
                  return (
                    <div className={"bar-slot " + groupClass} key={String(index) + "-" + String(originalValues.length)}>
                      <div
                        className={"bar " + getBarClass(index, currentStep, algorithm)}
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
                {isMeanPartition ? (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />current row</span>
                    <span><i className="legend__swatch legend__swatch--partition" />split groups</span>
                    <span><i className="legend__swatch legend__swatch--mean" />mean measured</span>
                    <span><i className="legend__swatch legend__swatch--rank" />groups ranked</span>
                  </>
                ) : (
                  <>
                    <span><i className="legend__swatch legend__swatch--idle" />unsorted</span>
                    <span><i className="legend__swatch legend__swatch--sorted" />sorted prefix</span>
                    <span><i className="legend__swatch legend__swatch--key" />active key</span>
                    <span><i className="legend__swatch legend__swatch--compare" />comparison</span>
                  </>
                )}
              </div>
              <div className="motion-note">
                {prefersReducedMotion ? "Reduced motion is on" : "Adjustable speed"}
              </div>
            </div>
          </div>

          <div className="stats" aria-label="Sort statistics">
            <div className="stat-card">
              <span>{isMeanPartition ? "ROUND" : "PASS"}</span>
              <strong>{currentStep.pass}<em> / {totalStages}</em></strong>
              <p>{isMeanPartition ? "mean grouping" : "key placement"}</p>
            </div>
            <div className="stat-card">
              <span>{isMeanPartition ? "MEANS READ" : "COMPARISONS"}</span>
              <strong>{currentStep.comparisons}</strong>
              <p>{isMeanPartition ? "group averages" : "values checked"}</p>
            </div>
            <div className="stat-card">
              <span>{isMeanPartition ? "VALUES MOVED" : "ARRAY WRITES"}</span>
              <strong>{currentStep.writes}</strong>
              <p>{isMeanPartition ? "re-ranked groups" : "shifts + inserts"}</p>
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
            <p className="eyebrow">{isMeanPartition ? "EXPERIMENTAL IDEA" : "THE BIG IDEA"}</p>
            <h2 id="learn-title">
              {isMeanPartition
                ? "Sort blocks before sorting values."
                : "Like sorting cards in your hand."}
            </h2>
            <p>
              {isMeanPartition
                ? "Each round splits the newly arranged row into more balanced groups, calculates every group average, then ranks all groups from low mean to high mean. A mean does not guarantee that a whole block belongs before another one, so the process continues until each group holds one value."
                : "Insertion sort grows a tidy section from left to right. It picks up one value, shifts larger neighbors aside, then drops that value into the gap it created."}
            </p>
            <div className="complexity-row" aria-label={algorithmLabel + " characteristics"}>
              {isMeanPartition ? (
                <>
                  <span><b>ROUNDS</b> O(log n)</span>
                  <span><b>GUARANTEE</b> singleton round</span>
                  <span><b>SPACE</b> O(n)</span>
                </>
              ) : (
                <>
                  <span><b>BEST</b> O(n)</span>
                  <span><b>AVERAGE</b> O(n²)</span>
                  <span><b>SPACE</b> O(1)</span>
                </>
              )}
            </div>
          </div>

          <div className="algorithm-card">
            <div className="algorithm-card__header">
              <span>{isMeanPartition ? "MEAN PARTITION SORT" : "INSERTION SORT"}</span>
              <span>{isMeanPartition ? "experimental · group-based" : "stable · in-place"}</span>
            </div>
            <ol className="algorithm-steps">
              {isMeanPartition ? (
                <>
                  <li><i>01</i><span>Split the current row into <b>2, 4, 8…</b> balanced groups.</span></li>
                  <li><i>02</i><span>Calculate the average of every group.</span></li>
                  <li><i>03</i><span>Rank all groups from the smallest mean to the largest.</span></li>
                  <li><i>04</i><span>At singleton groups, each mean is the <b>value itself</b>.</span></li>
                </>
              ) : (
                <>
                  <li><i>01</i><span>Choose the next value as the <b>key</b>.</span></li>
                  <li><i>02</i><span>Compare it to values in the sorted prefix.</span></li>
                  <li><i>03</i><span>Shift larger values right, then insert the key.</span></li>
                </>
              )}
            </ol>
          </div>
        </section>

        <section className="comparison-lab" aria-labelledby="comparison-title">
          <div className="comparison-lab__header">
            <div>
              <p className="eyebrow">EFFICIENCY LAB</p>
              <h2 id="comparison-title">Compare the work behind the motion.</h2>
              <p>
                Both algorithms receive the same shuffled sequence of 1 through n.
                The chart totals value checks or group-mean reads, group-ranking
                checks, and item moves, so it is an operation estimate rather than a timer.
              </p>
            </div>
            <label className="benchmark-select">
              <span>Test arrangement</span>
              <select
                value={benchmarkPattern}
                onChange={(event) => setBenchmarkPattern(event.target.value as BenchmarkPattern)}
                aria-label="Benchmark test arrangement"
              >
                <option value="random">Random shuffle</option>
                <option value="reverse">Reverse order</option>
                <option value="nearly-sorted">Nearly sorted</option>
              </select>
            </label>
          </div>

          <div
            className="benchmark-chart"
            role="img"
            aria-label={"Estimated work for insertion sort and mean partition sort on " + benchmarkPattern + " arrays from 16 through 256 values."}
          >
            <div className="benchmark-chart__scale">
              <span>{formatCount(benchmarkMaximum)} work units</span>
              <span>0</span>
            </div>
            <div className="benchmark-columns" aria-hidden="true">
              {benchmarkData.map((entry) => {
                const insertionHeight = Math.max(
                  3,
                  (entry.insertionWork / benchmarkMaximum) * 100,
                );
                const meanHeight = Math.max(
                  3,
                  (entry.meanWork / benchmarkMaximum) * 100,
                );

                return (
                  <div className="benchmark-group" key={entry.size}>
                    <div className="benchmark-bars">
                      <div className="benchmark-bar benchmark-bar--insertion" style={{ height: String(insertionHeight) + "%" }} />
                      <div className="benchmark-bar benchmark-bar--mean" style={{ height: String(meanHeight) + "%" }} />
                    </div>
                    <span>n={entry.size}</span>
                  </div>
                );
              })}
            </div>
            <div className="benchmark-legend" aria-hidden="true">
              <span><i className="benchmark-legend__swatch benchmark-legend__swatch--insertion" />Insertion sort</span>
              <span><i className="benchmark-legend__swatch benchmark-legend__swatch--mean" />Mean partition sort</span>
            </div>
          </div>

          <div className="benchmark-current" aria-label={"Current benchmark at " + arraySize + " values"}>
            <div>
              <span>AT n={arraySize}</span>
              <strong>Insertion sort</strong>
              <i><b style={{ width: String((selectedBenchmark.insertion / Math.max(selectedBenchmark.insertion, selectedBenchmark.meanPartition, 1)) * 100) + "%" }} /></i>
              <em>{formatCount(selectedBenchmark.insertion)} work units</em>
            </div>
            <div>
              <span>AT n={arraySize}</span>
              <strong>Mean partition sort</strong>
              <i><b className="benchmark-current__mean" style={{ width: String((selectedBenchmark.meanPartition / Math.max(selectedBenchmark.insertion, selectedBenchmark.meanPartition, 1)) * 100) + "%" }} /></i>
              <em>{formatCount(selectedBenchmark.meanPartition)} work units</em>
            </div>
          </div>
        </section>

        <p className="sr-only" aria-live="polite" aria-atomic="true">{liveStatus}</p>
      </div>
    </main>
  );
}
