import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { Road } from "./osm.ts";
import { flightSteps, stepAtFlights } from "./flights.ts";

function steps(line: Point[], extra: Partial<Road> = {}): Road {
  return { osm: "w1", kind: "steps", width: 4, layer: 0, bridge: false, tunnel: false, stepCount: 10, line, ...extra };
}

// a slab 1.6 m over a square along n = 0, which the model smooths into a slope from n = 3 down to n = -3
const smoothed = (_e: number, n: number) => (n >= 3 ? 102.2 : n <= -3 ? 100.6 : 100.6 + (1.6 * (n + 3)) / 6);

test("a flight of steps down off a slab the model smooths steps the ground: the slab up to its top, the square to its foot", () => {
  // ten risers down from the slab's edge at n = 0 to the square at n = -4
  const flight = steps([[0, 0], [0, -4]]);
  const flights = flightSteps([flight], smoothed);
  assert.equal(flights.length, 1);
  const ground = stepAtFlights(smoothed, flights);
  const at = (e: number, n: number) => Math.round((ground(e, n) ?? NaN) * 100) / 100;
  // the top on the slab's level, behind it the slab raised to it, under the flight straight down to the foot
  assert.equal(at(0, 0), 102.2);
  assert.equal(at(0, 2), 102.2);
  assert.equal(at(0, -2), 101.4);
  assert.equal(at(0, -4), 100.6);
  // past the foot the square lowered to it
  assert.equal(at(0, -5), 100.6);
  // beyond the flight's width and its ease, and far past its ends, the model as it is
  for (const [e, n] of [[10, -1], [0, 10], [0, -10]] satisfies Point[]) {
    assert.equal(ground(e, n), smoothed(e, n));
  }
  // the other way round, from foot to top, the same
  const up = stepAtFlights(smoothed, flightSteps([steps([[0, -4], [0, 0]])], smoothed));
  assert.equal(Math.round((up(0, -2) ?? NaN) * 100) / 100, 101.4);
});

test("steps up a slope the model has as it is, or without a step count, on a bridge, or turning, step nothing", () => {
  // a hill climbing 0.16 m a meter: ten risers in 10 m
  const hill = (_e: number, n: number) => 100 + 0.16 * n;
  assert.deepEqual(flightSteps([steps([[0, 0], [0, 10]])], hill), []);
  assert.deepEqual(flightSteps([steps([[0, 0], [0, -4]], { stepCount: undefined })], smoothed), []);
  assert.deepEqual(flightSteps([steps([[0, 0], [0, -4]], { bridge: true, layer: 1 })], smoothed), []);
  assert.deepEqual(flightSteps([steps([[0, 0], [3, -2], [0, -4]])], smoothed), []);
  // a short flight on a bank going on up past its top and down past its foot: the ground found there is further apart
  // than ten risers climb
  const bank = (_e: number, n: number) => 100 + 0.3 * n;
  assert.deepEqual(flightSteps([steps([[0, 1], [0, -1]])], bank), []);
});
