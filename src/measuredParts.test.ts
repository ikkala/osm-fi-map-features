import assert from "node:assert/strict";
import { test } from "node:test";
import { ringArea, type Point } from "./geometry.ts";
import { splitByMeasuredParts } from "./measuredParts.ts";
import type { Building } from "./osm.ts";
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

test("what no measured part covers goes to the part nearest it", () => {
  // the parts leave 4 m at the east end uncovered: it goes to the tower beside it
  const b = outline();
  const { parts } = splitByMeasuredParts([b], [part(0, 16, 6), part(16, 20, 22)]);
  const tower = parts.find((p) => p.height === 22);
  assert.ok(tower);
  assert.ok(Math.abs(area(tower) - 240) < 1e-6);
  assert.ok(Math.abs(parts.reduce((sum, p) => sum + area(p), 0) - 400) < 1e-6);
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
});
