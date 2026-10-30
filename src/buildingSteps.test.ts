import assert from "node:assert/strict";
import { test } from "node:test";
import { buildingSteps, cutBuildingSteps } from "./buildingSteps.ts";
import type { Point } from "./geometry.ts";
import type { Building } from "./osm.ts";
import { REACH_M, stepAtWalls } from "./retainingWalls.ts";
import { cutIntoTiles, tileName } from "./tiles.ts";

function building(osm: string, outer: Point[], extra: Partial<Building> = {}): Building {
  return { osm, kind: "yes", part: false, hasParts: false, height: 9, minHeight: 0, polygon: { outer, holes: [] }, ...extra };
}

// a building from n = 0 to 20 cut into a hill of 90 in the north, the model's slope from its south wall down to the
// street of 80 at n = -4; flat east and west of it
const hill = (e: number, n: number) => (e < 0 || e > 40 ? 80 : n <= -4 ? 80 : n >= 2 ? 90 : 80 + ((n + 4) / 6) * 10);
const round = (h: number | undefined) => (h === undefined ? undefined : Math.round(h * 100) / 100);
const box: Point[] = [[0, 0], [40, 0], [40, 20], [0, 20]];

test("a building's wall steps the ground down outside it, to the slope's foot, its insides left as they are", () => {
  for (const outer of [box, [...box].reverse()]) {
    const ground = stepAtWalls(hill, buildingSteps([building("w1", outer)], [], hill));
    // on the wall's line the ground is the outside's
    assert.deepEqual([-3, -1, 0, 1, 5].map((n) => round(ground(20, n))), [80, 80, 80, round(hill(20, 1)), 90]);
  }
});

test("a building on even ground or a long slope going on past reach steps nothing", () => {
  const slope = (_e: number, n: number) => 80 + n / 2;
  assert.deepEqual(buildingSteps([building("w1", box)], [], () => 80), []);
  assert.deepEqual(buildingSteps([building("w1", box)], [], slope), []);
});

test("a building on the edge of a bank falling away from it, its ground level inside, steps nothing", () => {
  // level at 90 up to the wall at n = 0, down to 80 at n = -4
  const bank = (_e: number, n: number) => (n >= 0 ? 90 : n <= -4 ? 80 : 90 + n * 2.5);
  assert.deepEqual(buildingSteps([building("w1", box)], [], bank), []);
});

test("a wall over a bank down to the water steps nothing", () => {
  const river = { outer: [[-10, -20], [50, -20], [50, -3], [-10, -3]] satisfies Point[], holes: [] };
  assert.deepEqual(buildingSteps([building("w1", box)], [], hill, [river]), []);
});

test("a wall with a dam within its slope's reach steps nothing there", () => {
  const steps = buildingSteps([building("w1", box)], [], hill, [], [[[20, -3], [20, -10]]]);
  const middles = steps.filter((s) => s.a[1] === 0 && s.b[1] === 0).map((s) => (s.a[0] + s.b[0]) / 2);
  assert.ok(middles.length > 0 && middles.every((e) => Math.abs(e - 20) > 4));
});

test("a wall with steps climbing its slope steps nothing there", () => {
  const ways = [{ line: [[20, -6], [20, 0]] satisfies Point[], width: 2, kind: "steps" }];
  const steps = buildingSteps([building("w1", box)], ways, hill);
  const middles = steps.filter((s) => s.a[1] === 0 && s.b[1] === 0).map((s) => (s.a[0] + s.b[0]) / 2);
  assert.ok(middles.length > 0 && middles.every((e) => Math.abs(e - 20) > 4));
});

test("walls not standing on the ground step nothing: shelters, lattices, raised buildings and parts", () => {
  const steps = buildingSteps(
    [
      building("w1", box, { shelter: "roof" }),
      building("w2", box, { lattice: true }),
      building("w3", box, { minHeight: 3 }),
      building("w4", box, { part: true }),
    ],
    [],
    hill,
  );
  assert.deepEqual(steps, []);
});

test("a part in no outline stands on its own walls; one in an outline steps nothing, the outline's walls do", () => {
  const ground = stepAtWalls(hill, buildingSteps([building("w5", box, { part: true })], [], hill));
  assert.deepEqual([-1, 0].map((n) => round(ground(20, n))), [80, 80]);
  const held = buildingSteps([building("w6", box), building("w7", [[5, 0], [35, 0], [35, 10], [5, 10]], { part: true })], [], hill);
  assert.ok(held.length > 0);
  assert.deepEqual([...new Set(held.map((step) => step.wall))], ["w6"]);
});

test("a wall is not stepped where a way goes through it, nor where another building stands outside it", () => {
  // a passage of 4 m through the building at e = 10, a footway ending at the wall at e = 30
  const ways = [
    { line: [[10, -10], [10, 10]] satisfies Point[], width: 4 },
    { line: [[30, -10], [30, 0]] satisfies Point[], width: 2 },
  ];
  // a lower building in front of the wall from e = 18 to 22
  const front = building("w2", [[18, -6], [22, -6], [22, 0], [18, 0]], { height: 3 });
  const steps = buildingSteps([building("w1", box), front], ways, hill).filter((s) => s.wall === "w1" && s.a[1] === 0 && s.b[1] === 0);
  const middles = steps.map((s) => (s.a[0] + s.b[0]) / 2);
  // through the passage, its half width and THROUGH_MARGIN_M either way, and in front of the lower building
  assert.ok(middles.every((e) => Math.abs(e - 10) >= 3 && (e < 18 || e > 22)));
  assert.ok(middles.some((e) => e > 29 && e < 31));
  // the stretches go from a to b with the building on the left
  assert.ok(steps.every((s) => s.a[0] < s.b[0] && s.low === -1));
});

test("a tile gets the stretches within reach of it, the tiles' around too", () => {
  const steps = buildingSteps([building("w1", box)], [], hill);
  const empty = { roads: [], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  const tiles = new Map(cutIntoTiles(empty, [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: 0, y: -2 }], 100).map((tile) => [tileName(tile), tile]));
  cutBuildingSteps(tiles, steps, 100);
  assert.equal(tiles.get("0_0")?.buildingSteps?.length, steps.length);
  // the south wall's, and the side walls' up to REACH_M north of the edge
  assert.equal(tiles.get("0_-1")?.buildingSteps?.length, steps.filter((s) => Math.min(s.a[1], s.b[1]) < REACH_M).length);
  assert.equal(tiles.get("0_-2")?.buildingSteps, undefined);
});
