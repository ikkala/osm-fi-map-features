import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import { roofShareOf, wingRidges } from "./roofWings.ts";

test("an L cuts into wings whose ridges meet at its corner, each from its gable", () => {
  // a wing 24 m by 10 east to west, another 8 m wide north from its east end
  const L: Point[] = [[0, 0], [24, 0], [24, 20], [16, 20], [16, 10], [0, 10]];
  const [ways] = wingRidges(L);
  const round = (lines: Point[][]) => lines.map((line) => line.map(([e, n]) => [Math.round(e * 10) / 10, Math.round(n * 10) / 10]));
  assert.deepEqual(round(ways.gabled), [[[0, 5], [20, 5]], [[20, 20], [20, 5]]]);
  assert.equal(ways.run, 5);
  const share = roofShareOf(L, ways.gabled);
  // on the main ridge, half way down its slope, at the wing's gable under its ridge, and on the wing's side of the hip
  // down to the outer corner
  assert.deepEqual([[12, 5], [12, 2.5], [20, 19.9], [22, 3]].map((p) => Math.round((share?.([p[0], p[1]]) ?? -1) * 100) / 100), [1, 0.5, 1, 0.5]);
  // a rectangle has its own shapes
  assert.deepEqual(wingRidges([[0, 0], [20, 0], [20, 10], [0, 10]]), []);
});

test("a wing too short for a hipped ridge of its own has no hipped roof of wings, and none hangs", () => {
  const ring: Point[] = [[-2447.8, -3538.1], [-2449.9, -3547.9], [-2434.1, -3551.2], [-2435.9, -3559.5], [-2409.5, -3565.1], [-2405.7, -3547]];
  const ways = wingRidges(ring);
  assert.equal(ways.length, 1);
  assert.deepEqual(ways[0].hipped, []);
  assert.ok(roofShareOf(ring, ways[0].gabled));
});
