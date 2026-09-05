import assert from "node:assert/strict";
import test from "node:test";
import {
  makeArrayForArrangement,
  type ArrayArrangement,
} from "../app/lib/array-arrangements";

function countInversions(values: number[]) {
  let inversions = 0;
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (values[left] > values[right]) inversions += 1;
    }
  }
  return inversions;
}

test("every control-room arrangement remains a clean 1-through-N permutation", () => {
  const arrangements: ArrayArrangement[] = ["random", "reverse", "nearly-sorted"];
  const expected = Array.from({ length: 64 }, (_, index) => index + 1);

  for (const arrangement of arrangements) {
    const values = makeArrayForArrangement(64, arrangement, () => 0.37);
    assert.deepEqual([...values].sort((left, right) => left - right), expected);
  }
});

test("reverse arrangement is an exact descending row", () => {
  assert.deepEqual(makeArrayForArrangement(6, "reverse"), [6, 5, 4, 3, 2, 1]);
});

test("nearly sorted rows stay sparse and never accidentally sorted", () => {
  for (const length of [4, 8, 16, 24, 64, 256]) {
    const nearlySorted = makeArrayForArrangement(length, "nearly-sorted");
    const reverse = makeArrayForArrangement(length, "reverse");
    const nearInversions = countInversions(nearlySorted);
    const reverseInversions = countInversions(reverse);

    assert.ok(nearInversions > 0, "length " + length + " should not be sorted");
    assert.ok(
      nearInversions < reverseInversions,
      "length " + length + " should be much closer to sorted than reverse order",
    );
    assert.ok(
      nearInversions <= Math.max(1, Math.floor(length / 16)),
      "length " + length + " should contain only sparse adjacent inversions",
    );
  }
});

test("random arrangement uses the injected Fisher-Yates random source", () => {
  const alwaysFirst = () => 0;

  assert.deepEqual(makeArrayForArrangement(4, "random", alwaysFirst), [2, 3, 4, 1]);
  assert.deepEqual(makeArrayForArrangement(4, "random", alwaysFirst), [2, 3, 4, 1]);
});
