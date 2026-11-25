import assert from "node:assert/strict";
import { test } from "node:test";
import { ringArea, type Point } from "./geometry.ts";
import { splitByMeasuredParts } from "./measuredParts.ts";
import type { Building, Road } from "./osm.ts";
import type { MeasuredPart } from "./roofTops.ts";

const BASE = 90;

function rectangle(x: number, y: number, width: number, depth: number): Point[] {
  return [[x, y], [x + width, y], [x + width, y + depth], [x, y + depth]];
}

/** An outline 40 m east by 10 m north, standing at BASE, 20 m tall by its tags */
function outline(extra: Partial<Building> = {}): Building {
  return {
    osm: "w1",
    kind: "apartments",
    part: false,
    hasParts: false,
    height: 20,
    minHeight: 0,
    base: BASE,
    levels: 6,
    roofShape: "gabled",
    roofShapeEstimated: true,
    name: "Talo",
    material: "brick",
    polygon: { outer: rectangle(0, 0, 40, 10), holes: [] },
    ...extra,
  };
}

function part(x: number, width: number, top: number, y = 0, depth = 10): MeasuredPart {
  return { polygon: { outer: rectangle(x, y, width, depth), holes: [] }, top: BASE + top };
}

const area = (b: Building) => Math.abs(ringArea(b.polygon.outer));

function bounds(p: Building | undefined) {
  const xs = p?.polygon.outer.map(([x]) => x) ?? [];
  const ys = p?.polygon.outer.map(([, y]) => y) ?? [];
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

test("an outline over parts of clearly different heights becomes an outline with parts of their heights", () => {
  // a hall of 9 m, a link of 5 m and a tower of 24 m in two parts of about one height
  const b = outline();
  const { split, parts } = splitByMeasuredParts([b], [part(0, 15, 9), part(15, 5, 5), part(20, 12, 24), part(32, 8, 23.5)]);
  assert.equal(split, 1);
  assert.equal(b.hasParts, true);
  assert.deepEqual(parts.map((p) => p.height).sort((x, y) => x - y), [5, 9, 24]);
  assert.ok(parts.every((p) => p.part && !p.hasParts && p.base === BASE && p.material === "brick"));
  // the tower's two parts as one, its height theirs by area
  const tower = parts.find((p) => p.height === 24);
  assert.ok(tower);
  assert.ok(Math.abs(area(tower) - 200) < 1e-6);
  // flat roofs, storeys of the outline's storeys' height, the outline's name and ids its own
  assert.ok(parts.every((p) => p.roofShape === undefined && p.name === undefined && p.levels !== undefined && p.levels >= 1));
  assert.deepEqual(new Set(parts.map((p) => p.osm)), new Set(["w1:1", "w1:2", "w1:3"]));
});

test("an outline's entrances go to the parts they are on, and leave the outline", () => {
  const b = outline({ entrances: [{ at: [5, 0], kind: "main" }, { at: [36, 10], kind: "yes" }] });
  const { parts } = splitByMeasuredParts([b], [part(0, 15, 9), part(15, 25, 24)]);
  assert.equal(b.entrances, undefined);
  const hall = parts.find((p) => p.height === 9);
  const tower = parts.find((p) => p.height === 24);
  assert.deepEqual(hall?.entrances?.map((e) => e.kind), ["main"]);
  assert.deepEqual(tower?.entrances?.map((e) => e.kind), ["yes"]);
});

test("what no measured part covers goes to the part nearest it", () => {
  // the parts leave 4 m at the east end uncovered: it goes to the tower beside it
  const b = outline();
  const { parts } = splitByMeasuredParts([b], [part(0, 16, 6), part(16, 20, 22)]);
  const tower = parts.find((p) => p.height === 22);
  assert.ok(tower);
  assert.ok(Math.abs(area(tower) - 240) < 1e-6);
  assert.ok(Math.abs(parts.reduce((sum, p) => sum + area(p), 0) - 400) < 1e-6);
});

test("a sliver the parts leave along the outline goes to the part it runs along, not as a thin wall to a taller one", () => {
  // both parts a little inside the outline: what they leave is a ring round them, its middle in the tower
  const b = outline();
  const inset = (x: number, width: number, top: number) => part(x, width, top, 0.2, 9.6);
  const { parts } = splitByMeasuredParts([b], [inset(0.2, 27.8, 24), inset(28, 11.8, 6)]);
  const hall = bounds(parts.find((p) => p.height === 6));
  const tower = bounds(parts.find((p) => p.height === 24));
  assert.deepEqual([hall.maxX, hall.minY, hall.maxY], [40, 0, 10]);
  assert.deepEqual([tower.minX, tower.minY, tower.maxY], [0, 0, 10]);
  assert.ok(tower.maxX < 28.5, `the tower reaches ${tower.maxX}`);
  assert.ok(Math.abs(parts.reduce((sum, p) => sum + area(p), 0) - 400) < 1e-6);
});

test("a narrow part goes to a lower one beside it, not to stand over it as a thin wall, and stays a ledge before a higher one", () => {
  // a rim 1.5 m deep along the south side at 21 m, a hall of 11 m behind its west half and a tower of 27 m behind the east
  const { parts } = splitByMeasuredParts([outline()], [part(0, 40, 21, 0, 1.5), part(0, 20, 11, 1.5, 8.5), part(20, 20, 27, 1.5, 8.5)]);
  assert.deepEqual(parts.map((p) => p.height).sort((x, y) => x - y), [11, 21, 27]);
  const hall = bounds(parts.find((p) => p.height === 11));
  const ledge = bounds(parts.find((p) => p.height === 21));
  assert.deepEqual([hall.minX, hall.minY, hall.maxY], [0, 0, 10]);
  assert.ok(ledge.minX >= 20 && ledge.minY === 0 && ledge.maxY === 1.5, `the ledge is ${JSON.stringify(ledge)}`);
  assert.ok(Math.abs(parts.reduce((sum, p) => sum + area(p), 0) - 400) < 1e-6);
  // a rim with a leg out of the hall's reach, touching it alone: none of it stays
  const leg = { polygon: { outer: [[0, 6], [20, 6], [20, 7.5], [1.5, 7.5], [1.5, 10], [0, 10]] satisfies Point[], holes: [] }, top: BASE + 24 };
  const legged = splitByMeasuredParts([outline()], [part(0, 20, 6, 0, 6), part(20, 20, 30), leg]).parts;
  assert.deepEqual(legged.map((p) => p.height).sort((x, y) => x - y), [6, 30]);
  // a narrow tower along the outline over a hall: only the hall stands, and the outline is left as it is
  assert.equal(splitByMeasuredParts([outline()], [part(0, 40, 24, 0.3, 0.6), part(0, 40, 6, 0.9, 9.1)]).split, 0);
  // a canopy before a taller part: a ledge
  assert.deepEqual(splitByMeasuredParts([outline()], [part(0, 40, 4, 0, 2), part(0, 40, 20, 2, 8)]).parts.map((p) => p.height).sort((x, y) => x - y), [4, 20]);
});

test("an outline is left as it is when its parts are of about one height, cover too little of it, or it is no ordinary building", () => {
  const near = outline();
  assert.equal(splitByMeasuredParts([near], [part(0, 20, 18), part(20, 20, 21)]).split, 0);
  assert.equal(near.hasParts, false);
  assert.equal(splitByMeasuredParts([outline()], [part(0, 10, 6), part(10, 10, 22)]).split, 0);
  assert.equal(splitByMeasuredParts([outline({ hasParts: true })], [part(0, 20, 6), part(20, 20, 22)]).split, 0);
  assert.equal(splitByMeasuredParts([outline({ base: undefined })], [part(0, 20, 6), part(20, 20, 22)]).split, 0);
  // a piece too small to be a part, and a top too low to be a building's, are left out
  assert.equal(splitByMeasuredParts([outline()], [part(0, 39.5, 18), part(39.5, 0.5, 4)]).split, 0);
  assert.equal(splitByMeasuredParts([outline()], [part(0, 20, 1), part(20, 20, 18)]).split, 0);
  // a way into it, or through it with no point inside
  const road = (line: Point[]): Road => ({ osm: "w9", kind: "service", width: 3, layer: 0, bridge: false, tunnel: false, line });
  const split = [part(0, 20, 6), part(20, 20, 22)];
  assert.equal(splitByMeasuredParts([outline()], split, [road([[5, -5], [5, 3]])]).split, 0);
  assert.equal(splitByMeasuredParts([outline()], split, [road([[10, -5], [12, 15]])]).split, 0);
  assert.equal(splitByMeasuredParts([outline()], split, [road([[-5, -5], [50, -5]])]).split, 1);
  // a tunnel beside it, its room reaching it
  assert.equal(splitByMeasuredParts([outline()], split, [{ ...road([[-5, -2], [50, -2]]), tunnel: true }]).split, 0);
});
