import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PLINTH_M, setBuildingBases } from "./bases.ts";
import type { Point } from "./geometry.ts";
import type { Building } from "./osm.ts";

function square(x: number, size: number, extra: Partial<Building> = {}): Building {
  const outer: Point[] = [[x, 0], [x + size, 0], [x + size, size], [x, size]];
  return { osm: `w${x}`, kind: "yes", part: false, hasParts: false, height: 9, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

// ground rising 0.5 m for every meter east, with a hump on the first building's west edge between its corners
const heightAt = (e: number, n: number) => (e < 200 ? 100 + e / 2 + (e === 0 && n === 4 ? 5.5 : 0) : undefined);

test("setBuildingBases stands buildings at their highest ground, at most MAX_PLINTH_M over their lowest", () => {
  const house = square(0, 10);
  const long = square(40, 40);
  const shelter = square(100, 4, { shelter: "roof" });
  const outside = square(300, 10);
  assert.equal(setBuildingBases([house, long, shelter, outside], heightAt), 2);
  // the hump between the corners (105.5) is over the east edge (105)
  assert.equal(house.base, 105.5);
  assert.equal(long.base, 120 + MAX_PLINTH_M);
  assert.deepEqual([shelter.base, outside.base], [undefined, undefined]);
});

test("setBuildingBases gives parts the base of their building", () => {
  const outline = square(0, 30, { hasParts: true });
  const low = square(0, 5, { part: true });
  const high = square(20, 5, { part: true });
  setBuildingBases([outline, low, high], heightAt);
  assert.deepEqual([outline.base, low.base, high.base], [106, 106, 106]);
});

test("setBuildingBases stands a building at the ground by its OSM entrance, a main one first", () => {
  // ground 100 + e / 2: from 100 at the west edge to 105 at the east edge
  const main = square(0, 10, { entrances: [{ at: [8, 0], kind: "yes" }, { at: [2, 0], kind: "main" }] });
  const staircase = square(0, 10, { entrances: [{ at: [6, 10], kind: "staircase" }] });
  // guessed and service doors do not count
  const guessed = square(0, 10, { entrances: [{ at: [2, 0], kind: "main", guessed: true }, { at: [4, 0], kind: "service" }] });
  setBuildingBases([main, staircase, guessed], heightAt);
  // (the last at its highest ground: the hump on its west edge)
  assert.deepEqual([main.base, staircase.base, guessed.base], [101, 103, 105.5]);
  // a part stands where its building's entrance is
  const outline = square(0, 30, { hasParts: true, entrances: [{ at: [10, 0], kind: "main" }] });
  const part = square(20, 5, { part: true });
  setBuildingBases([outline, part], heightAt);
  assert.deepEqual([outline.base, part.base], [105, 105]);
});

test("setBuildingBases stands a building over a tunnel in a cut on the tunnel's lid", () => {
  // ground 100 + e / 2 (100 .. 105 under the building), its door at 101, and a lid at 108 .. 110 under it
  const station = square(0, 10, { entrances: [{ at: [2, 0], kind: "main" }] });
  const beside = square(40, 10);
  const lid = { line: [[-10, 5], [20, 5]] satisfies Point[], lid: [108, 110] };
  setBuildingBases([station, beside], heightAt, [lid]);
  // the lid's top at the last point sampled inside the building, e = 8 (every 2 m from e = -10)
  assert.equal(Math.round((station.base ?? 0) * 100) / 100, 109.2);
  assert.equal(beside.base, 125);
});
