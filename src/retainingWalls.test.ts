import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { Barrier } from "./osm.ts";
import { groundSteps, stepAtWalls } from "./retainingWalls.ts";
import { defined } from "./testing.ts";

function wall(osm: string, line: Point[]): Barrier {
  return { osm, kind: "retaining_wall", height: 1, line };
}

// a wall along n = 0 holding up 84 in the north over 80 in the south, the model's slope from n = -4 to 2
const blurred = (_e: number, n: number) => (n <= -4 ? 80 : n >= 2 ? 84 : 80 + ((n + 4) / 6) * 4);
const round = (h: number | undefined) => Math.round(defined(h) * 100) / 100;

test("a retaining wall steps the ground: down to the slope's foot on its low side, up to its top on the high side", () => {
  for (const line of [[[0, 0], [40, 0]], [[40, 0], [0, 0]]] satisfies Point[][]) {
    const ground = stepAtWalls(blurred, groundSteps([wall("w1", line)], blurred));
    assert.deepEqual([-6, -3, -1, 1, 3].map((n) => round(ground(20, n))), [80, 80, 80, 84, 84]);
    // the ground beyond the wall's ends is the model's
    assert.equal(round(ground(-3, -2)), round(blurred(-3, -2)));
  }
});

test("a retaining wall's step eases in toward its free ends, not where another wall goes on", () => {
  const steps = groundSteps([wall("w1", [[0, 0], [20, 0]]), wall("w2", [[20, 0], [40, 0]])], blurred);
  const ground = stepAtWalls(blurred, steps);
  const model = defined(blurred(1, -2));
  // a meter from the free end a quarter of the way down to the foot
  assert.equal(round(ground(1, -2)), Math.round((model - (model - 80) / 4) * 100) / 100);
  assert.equal(round(ground(20, -2)), 80);
  assert.deepEqual(new Set(steps.map((s) => s.wall)), new Set(["w1", "w2"]));
});

test("a retaining wall's stretch with no step leaves the ground beside it as it is, though the stretch on has one", () => {
  // the step ends at e = 20
  const ending = (e: number, n: number) => (e < 20 ? blurred(e, n) : 82);
  const ground = stepAtWalls(ending, groundSteps([wall("w1", [[0, 0], [40, 0]])], ending));
  assert.equal(round(ground(10, -2)), 80);
  assert.equal(round(ground(23, -2)), 82);
});

test("a retaining wall with a bank going on up past it, not flattening within reach, leaves the ground as it is", () => {
  // the ground climbs 0.5 m a meter north of the wall for 20 m
  const bank = (_e: number, n: number) => (n <= -2 ? 80 : 81 + Math.min(n, 20) / 2);
  const ground = stepAtWalls(bank, groundSteps([wall("w1", [[0, 0], [40, 0]])], bank));
  assert.deepEqual([-1, 1, 3].map((n) => round(ground(20, n))), [-1, 1, 3].map((n) => round(bank(20, n))));
});

test("a retaining wall the model has no step at, and other barriers, leave the ground as it is", () => {
  const flat = () => 90;
  assert.ok(groundSteps([wall("w1", [[0, 0], [40, 0]])], flat).every((s) => s.footOut === 0 && s.topIn === 0));
  assert.deepEqual(groundSteps([{ ...wall("w2", [[0, 0], [40, 0]]), kind: "wall" }], blurred), []);
});
