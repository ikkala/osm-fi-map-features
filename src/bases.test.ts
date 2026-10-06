import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PLINTH_M, setBuildingBases } from "./bases.ts";
import type { Point } from "./geometry.ts";
import type { Area, Building } from "./osm.ts";

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

test("setBuildingBases stands a carport at its highest ground as a building, not at its lowest corner as a shelter", () => {
  const carport = square(20, 6, { kind: "carport", shelter: "carport", height: 3, heightEstimated: true });
  const shelter = square(40, 6, { kind: "roof", shelter: "roof", height: 3 });
  assert.equal(setBuildingBases([carport, shelter], heightAt), 1);
  assert.deepEqual([carport.base, carport.height, shelter.base], [113, 3, undefined]);
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

test("setBuildingBases stands a canopy reaching over a platform on the platform's top, not over the tracks beside it", () => {
  // a platform at 96 from e = 2 to 8; the canopy over it reaches 2 m out over the tracks on both sides
  const platform: Area = { osm: "r7", kind: "platform", top: 96, polygon: { outer: [[2, -20], [8, -20], [8, 30], [2, 30]], holes: [] } };
  const canopy = square(0, 10, { kind: "roof", shelter: "roof" });
  const elsewhere = square(40, 4, { kind: "roof", shelter: "roof" });
  setBuildingBases([canopy, elsewhere], heightAt, [], [], [platform]);
  assert.deepEqual([canopy.base, elsewhere.base], [96, undefined]);
});

test("setBuildingBases counts the minHeight of a raised part with nothing under it from its own highest ground", () => {
  // the building stands at its door down the slope (101), the ground rising 0.5 m for every meter east
  const outline = square(0, 30, { hasParts: true, entrances: [{ at: [2, 0], kind: "main" }] });
  // a canopy 3-4 m up, whose highest ground is at its east edge (112.5): lifted whole
  const canopy = square(20, 5, { part: true, minHeight: 3, height: 4 });
  // floors over a passage, whose highest ground is 107.5: their top stays
  const arcade = square(10, 5, { part: true, minHeight: 3, height: 20 });
  // a storey on another part stays on it
  const lower = square(0, 5, { part: true, minHeight: 0, height: 6 });
  const upper = square(0, 5, { part: true, minHeight: 6, height: 20 });
  setBuildingBases([outline, canopy, arcade, lower, upper], heightAt);
  assert.deepEqual([canopy.base, canopy.minHeight, canopy.height], [101, 14.5, 15.5]);
  assert.deepEqual([arcade.minHeight, arcade.height], [9.5, 20]);
  assert.deepEqual([upper.minHeight, upper.height], [6, 20]);
});

test("an open roof of an estimated height is raised to leave room over the ways under it, on a slope", () => {
  // a covered walkway 10 m long up a slope of 1 in 2 (ground 100 at e = 0, 105 at e = 10), its roof 2.5 m tall
  const roof = square(0, 10, { kind: "roof", shelter: "roof", height: 2.5, heightEstimated: true });
  const tagged = square(20, 10, { kind: "roof", shelter: "roof", height: 2.5 });
  const walk = { line: [[-5, 5], [35, 5]] as Point[] };
  setBuildingBases([roof, tagged], heightAt, [], [], [], [walk]);
  // it stands at its lowest corner (100): the way's highest ground under it is 104.5 .. 105, at its edge
  assert.ok(roof.height >= 104.5 - 100 + 2.8 - 1e-9 && roof.height <= 105 - 100 + 2.8 + 1e-9, `height ${roof.height}`);
  // a tagged height stays
  assert.equal(tagged.height, 2.5);
});
