import assert from "node:assert/strict";
import test from "node:test";
import { cutGroundSteps, Ground, latticed, stepLines, stepReach, tileGroundAt } from "./ground.ts";
import type { Point } from "./geometry.ts";
import type { GroundStep } from "./retainingWalls.ts";
import { REACH_M } from "./retainingWalls.ts";
import { cutIntoTiles, tileName } from "./tiles.ts";

test("a ground's layers lie over those under them, in their order, and each stays as it was laid", () => {
  const ground = new Ground((e) => e);
  ground.lay("levelled", (below) => (e, n) => (below(e, n) ?? 0) + 1);
  const levelled = ground.at("levelled");
  ground.lay("walls", (below) => (e, n) => (below(e, n) ?? 0) * 2);
  assert.equal(ground.at("model")(3, 0), 3);
  assert.equal(levelled(3, 0), 4);
  assert.equal(ground.at("walls")(3, 0), 8);
  // the bare layer, passed over, is the levelled ground
  assert.equal(ground.at("bare")(3, 0), 4);
  assert.equal(ground.top(3, 0), 8);
});

test("a ground's layer cannot be laid out of order, nor asked for before it is laid", () => {
  const ground = new Ground(() => 0);
  ground.lay("portals", (below) => below);
  assert.throws(() => ground.lay("walls", (below) => below), /walls layer laid after its portals layer/);
  assert.throws(() => ground.at("buildings"), /buildings layer is not laid yet/);
});

test("latticed is the projection at the lattice's points and continuous across squares", () => {
  const toTm = (e: number, n: number): [number, number] => [e + 1e-4 * n * n, n + 1e-4 * e * e];
  const at = latticed(toTm, 100, 10);
  assert.deepEqual(at(30, 40), toTm(30, 40));
  for (const [e, n] of [
    [100, 55],
    [37, 200],
  ]) {
    const [a, b] = [at(e - 1e-9, n - 1e-9), at(e, n)];
    assert.ok(Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6);
  }
});

test("a tile's ground in a cell a step line crosses is the grid's out on the point's side, on the line its left side's", () => {
  // heights rising 1 m a column, a step line north through the middle of a column of cells, its left the west
  const count = 5;
  const values = Array.from({ length: count * count }, (_, i) => (i % count) * 10);
  const heights = { step: 2, count, values };
  const line: Point[] = [
    [5, 0],
    [5, 8],
  ];
  const ground = tileGroundAt(heights, [line]);
  const plain = tileGroundAt(heights);
  const reach = stepReach(2);
  assert.equal(ground(5.5, 4), plain(5 + reach, 4));
  assert.equal(ground(4.5, 4), plain(5 - reach, 4));
  assert.equal(ground(5, 4), plain(5 - reach, 4));
  // the lines are to decimeters: a point that near is on it
  assert.equal(ground(5.05, 4), plain(5 - reach, 4));
  // in a cell the line does not cross, the grid has no step to undo
  assert.equal(ground(3.5, 4), plain(3.5, 4));
  // past the line's ends, the grid's own
  assert.equal(ground(5.5, 9), plain(5.5, 9));
  // a line on the grid's points has the step smoothed into the cells either side
  const onPoints = tileGroundAt(heights, [[[4, 0], [4, 8]]]);
  assert.equal(onPoints(3.5, 4), plain(4 - reach, 4));
});

const stretch = (wall: string, a: Point, b: Point, low: 1 | -1): GroundStep => ({
  wall,
  a,
  b,
  low,
  foot: 0,
  footOut: 2,
  top: 0,
  topIn: 0,
  shareA: 1,
  shareB: 1,
});

test("the walls' stretches join into lines along their walls, each with the side a point on it takes on its left", () => {
  const lines = stepLines(
    [stretch("w1", [0, 0], [1, 0], 1), stretch("w1", [1, 0], [2, 0], 1), stretch("w1", [3, 0], [4, 0], 1), stretch("w2", [4, 0], [5, 0], -1)],
    "high",
  );
  // a straight wall's stretches one segment
  assert.deepEqual(lines, [
    [
      [2, 0],
      [0, 0],
    ],
    [
      [4, 0],
      [3, 0],
    ],
    [
      [4, 0],
      [5, 0],
    ],
  ]);
  // a building's outside, its low side, on the left
  assert.deepEqual(stepLines([stretch("w3", [0, 0], [1, 0], -1)], "low"), [
    [
      [1, 0],
      [0, 0],
    ],
  ]);
});

test("with the walls' lines standing, only the stretches on them join", () => {
  const steps = [stretch("w1", [0, 0], [1, 0], -1), stretch("w1", [1, 0], [2, 0], -1), stretch("w1", [2, 0], [3, 0], -1)];
  const standing: Point[][] = [
    [
      [0, 0],
      [1.2, 0],
    ],
    [
      [2.2, 0],
      [3, 0],
    ],
  ];
  assert.deepEqual(stepLines(steps, "high", standing), [
    [
      [0, 0],
      [1, 0],
    ],
    [
      [2, 0],
      [3, 0],
    ],
  ]);
});

test("a tile gets the pieces of the step lines within reach of it", () => {
  const empty = {
    roads: [],
    rails: [],
    buildings: [],
    areas: [],
    trees: [],
    lamps: [],
    crossings: [],
    signals: [],
    gates: [],
    barriers: [],
    playEquipment: [],
    bridgeDecks: [],
  };
  const tiles = new Map(
    cutIntoTiles(
      empty,
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
      100,
    ).map((tile) => [tileName(tile), tile]),
  );
  const line: Point[] = [
    [10, 50],
    [90, 50],
    [150, 50],
    [150, 99 - REACH_M],
  ];
  cutGroundSteps(tiles, [line], 100);
  assert.deepEqual(tiles.get("0_0")?.groundSteps, [line.slice(0, 3)]);
  assert.deepEqual(tiles.get("1_0")?.groundSteps, [line.slice(1)]);
  assert.equal(tiles.get("0_1")?.groundSteps, undefined);
});
