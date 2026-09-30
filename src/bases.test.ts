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

test("setBuildingBases raises a building whose roof would be under a door of its to its height over that door", () => {
  // a stair hall up the slope, 3.5 m tall, with a door at the street (100) and one up at the platform (105)
  const hall = square(0, 10, { height: 3.5, entrances: [{ at: [0, 5], kind: "yes" }, { at: [10, 5], kind: "yes" }] });
  // a house as tall as its doors want, and one with a guessed door up the slope, left as they are
  const house = square(0, 10, { height: 9, entrances: [{ at: [0, 5], kind: "yes" }, { at: [10, 5], kind: "yes" }] });
  const guessed = square(0, 10, { height: 3.5, entrances: [{ at: [0, 5], kind: "yes" }, { at: [10, 5], kind: "yes", guessed: true }] });
  const raised: Building[] = [];
  setBuildingBases([hall, house, guessed], heightAt, [], raised);
  assert.deepEqual([hall.base, hall.height, raised], [100, 8.5, [hall]]);
  assert.deepEqual([house.height, guessed.height], [9, 3.5]);
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

test("setBuildingBases stands an open shelter over a tunnel in a cut on the lid, and others get no base", () => {
  const platformRoof = square(0, 10, { kind: "roof", shelter: "roof" });
  const busShelter = square(40, 4, { kind: "roof", shelter: "public_transport" });
  const lid = { line: [[-10, 5], [20, 5]] satisfies Point[], lid: [108, 108] };
  setBuildingBases([platformRoof, busShelter], heightAt, [lid]);
  assert.deepEqual([platformRoof.base, busShelter.base], [108, undefined]);
});
