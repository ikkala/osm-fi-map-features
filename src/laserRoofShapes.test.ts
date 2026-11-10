import assert from "node:assert/strict";
import { test } from "node:test";
import type { Polygon } from "./geometry.ts";
import { applyLaserShapes, fitRoofShape, type LaserRoofShape } from "./laserRoofShapes.ts";
import type { Building } from "./osm.ts";

// a building 24 m by 12 m, its long side at 30° from east, centred at (1000, 2000)
const ANGLE = Math.PI / 6;
const [CX, CY] = [1000, 2000];
const toWorld = (u: number, v: number): [number, number] => [CX + u * Math.cos(ANGLE) - v * Math.sin(ANGLE), CY + u * Math.sin(ANGLE) + v * Math.cos(ANGLE)];
const OUTLINE: Polygon = { outer: [toWorld(-12, -6), toWorld(12, -6), toWorld(12, 6), toWorld(-12, 6)], holes: [] };

/** The points on a roof of height z(u, v) (m), half a point a square metre a metre in from the walls, a little noisy, and a chimney */
function scan(z: (u: number, v: number) => number): [number, number, number][] {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const points: [number, number, number][] = [];
  for (let i = 0; i < 0.5 * 22 * 10; i++) {
    const [u, v] = [-11 + 22 * random(), -5 + 10 * random()];
    points.push([...toWorld(u, v), z(u, v) + (random() - 0.5) * 0.2]);
  }
  // a chimney's points, 1.5 m over the roof
  for (const [u, v] of [[4, 1], [4.3, 1.2], [4.1, 0.8]]) {
    points.push([...toWorld(u, v), z(u, v) + 1.5]);
  }
  return points;
}

test("a roof's points tell its shape: gabled along or across, hipped, skillion or flat, and how much it rises", () => {
  const gabled = fitRoofShape(scan((_, v) => 110 - 0.6 * Math.abs(v)), OUTLINE);
  assert.equal(gabled?.shape, "gabled");
  assert.equal(gabled?.angle, 0);
  assert.ok(gabled && Math.abs(gabled.rise - 3.6) < 0.3 && Math.abs(gabled.top - 110) < 0.2, JSON.stringify(gabled));

  const across = fitRoofShape(scan((u) => 110 - 0.3 * Math.abs(u)), OUTLINE);
  assert.deepEqual([across?.shape, across?.angle], ["gabled", 90]);

  const hipped = fitRoofShape(scan((u, v) => 110 - 0.6 * Math.max(Math.abs(v), Math.abs(u) - 6)), OUTLINE);
  assert.deepEqual([hipped?.shape, hipped?.angle], ["hipped", 0]);

  // sloping down across the long side, to its left
  const skillion = fitRoofShape(scan((_, v) => 106 - 0.25 * v), OUTLINE);
  assert.equal(skillion?.shape, "skillion");
  assert.ok(skillion && Math.abs(skillion.angle - 90) < 5 && Math.abs(skillion.rise - 3) < 0.4, JSON.stringify(skillion));

  const flat = fitRoofShape(scan(() => 104), OUTLINE);
  assert.ok(flat && flat.shape === undefined && Math.abs(flat.top - 104) < 0.1, JSON.stringify(flat));
  // a rise too little to tell is flat
  assert.equal(fitRoofShape(scan((_, v) => 104 - 0.08 * Math.abs(v)), OUTLINE)?.shape, undefined);
});

test("too few points, or points fitting no shape, tell none", () => {
  assert.equal(fitRoofShape(scan(() => 104).slice(0, 20), OUTLINE), undefined);
  let seed = 3;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const scattered = scan(() => 104).map(([e, n]): [number, number, number] => [e, n, 100 + 8 * random()]);
  assert.equal(fitRoofShape(scattered, OUTLINE), undefined);
});

test("buildings OSM tells no roof shape of take the one the points tell, turned as their outline", () => {
  const building = (fields: Partial<Building> = {}): Building => ({
    osm: "w1",
    kind: "yes",
    part: false,
    hasParts: false,
    height: 12,
    minHeight: 0,
    base: 100,
    roofShapeEstimated: true,
    // 24 m by 12 m, its long side north
    polygon: { outer: [[0, 0], [12, 0], [12, 24], [0, 24]], holes: [] },
    ...fields,
  });
  const gabled = { shape: "gabled" as const, angle: 90, rise: 4, top: 113 };
  const [across, tagged, small, guessed] = [building(), building({ roofShapeEstimated: undefined }), building({ polygon: { outer: [[0, 0], [8, 0], [8, 10], [0, 10]], holes: [] } }), building({ roofShape: "hipped", roofHeight: 2, roofHeightEstimated: true, heightEstimated: true })];
  const shapes = new Map<Building, LaserRoofShape>([[across, gabled], [tagged, gabled], [small, gabled], [guessed, { angle: 0, rise: 0, top: 109 }]]);
  assert.deepEqual(applyLaserShapes([across, tagged, small, guessed], (b) => shapes.get(b)), { pitched: 1, flattened: 1 });
  // the ridge across the long side, which is north: east to west
  assert.deepEqual([across.roofShape, across.roofAngle, across.roofHeight], ["gabled", 180, 4]);
  assert.equal(tagged.roofShape, undefined);
  assert.equal(small.roofShape, undefined);
  // a guessed roof the points tell flat, and its height measured
  assert.deepEqual([guessed.roofShape, guessed.roofHeight, guessed.height], [undefined, undefined, 9]);
});

test("a flat roof only where the points lie flat: a tree's crown tells none", () => {
  // the crowns of trees where a newer building stands, a metre or so up and down
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  assert.equal(fitRoofShape(scan(() => 106 + (random() - 0.5) * 1.6), OUTLINE), undefined);
});
