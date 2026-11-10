import assert from "node:assert/strict";
import { test } from "node:test";
import { distanceToRing, pointInRing, ringArea, type Polygon } from "./geometry.ts";
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
  assert.equal(fitRoofShape(scan(() => 104).slice(0, 8), OUTLINE), undefined);
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
  const [across, tagged, small, guessed] = [building(), building({ roofShapeEstimated: undefined }), building({ polygon: { outer: [[0, 0], [5, 0], [5, 6], [0, 6]], holes: [] } }), building({ roofShape: "hipped", roofHeight: 2, roofHeightEstimated: true, heightEstimated: true })];
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

/** Points over a ring at half a point a square metre, a metre in from its walls, at the heights z gives, a little noisy */
function scanRing(ring: [number, number][], z: (e: number, n: number) => number): [number, number, number][] {
  let seed = 5;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const [es, ns] = [ring.map(([e]) => e), ring.map(([, n]) => n)];
  const points: [number, number, number][] = [];
  while (points.length < 0.5 * Math.abs(ringArea(ring))) {
    const p: [number, number] = [Math.min(...es) + random() * (Math.max(...es) - Math.min(...es)), Math.min(...ns) + random() * (Math.max(...ns) - Math.min(...ns))];
    if (pointInRing(p, ring) && distanceToRing(p, ring) >= 1) {
      points.push([...p, z(...p) + (random() - 0.5) * 0.2]);
    }
  }
  return points;
}

test("an L's roof and a T's are of wings: their ridges, gabled or hipped, drawn as their points tell", () => {
  // an L: a wing 24 m by 10 east to west, another 8 m wide north from its east end, gabled roofs 3 m high
  const L: [number, number][] = [[0, 0], [24, 0], [24, 20], [16, 20], [16, 10], [0, 10]];
  // the height under each wing's ridge, down 0.6 m a metre to its eaves, the higher where they join
  const height = (e: number, n: number) => {
    const main = n <= 10 ? 103 - 0.6 * Math.abs(n - 5) : -Infinity;
    const wing = e >= 16 && n >= 5 ? 103 - 0.75 * Math.abs(e - 20) : -Infinity;
    return Math.max(main, wing);
  };
  const shape = fitRoofShape(scanRing(L, height), { outer: L, holes: [] });
  assert.ok(shape && shape.wings !== undefined && shape.shape === "gabled" && Math.abs(shape.rise - 3) < 0.4, JSON.stringify(shape));
  // drawn on a building: faces from the ridges, no shape of the box's
  const b: Building = { osm: "w2", kind: "yes", part: false, hasParts: false, height: 9, minHeight: 0, base: 94, roofShapeEstimated: true, polygon: { outer: L, holes: [] } };
  assert.deepEqual(applyLaserShapes([b], () => shape), { pitched: 1, flattened: 0 });
  assert.ok(b.roofFaces && b.roofFaces.triangles.length > 0 && b.roofShape === undefined && b.roofHeight !== undefined && Math.abs(b.roofHeight - 3) < 0.4);

  // a T: a bar 30 m by 10, a stem 8 m wide north from its middle, hipped at its ends
  const T: [number, number][] = [[0, 0], [30, 0], [30, 10], [19, 10], [19, 22], [11, 22], [11, 10], [0, 10]];
  const hipped = (e: number, n: number) => {
    const bar = n <= 10 ? 103 - 0.6 * Math.max(Math.abs(n - 5), 5 - Math.min(e, 30 - e)) : -Infinity;
    const stem = e >= 11 && e <= 19 && n >= 5 ? 103 - 0.75 * Math.max(Math.abs(e - 15), 4 - (22 - n)) : -Infinity;
    return Math.max(bar, stem);
  };
  const tShape = fitRoofShape(scanRing(T, hipped), { outer: T, holes: [] });
  // hipped ends small beside the wings: hipped or gabled fit about as well
  assert.ok(tShape && tShape.wings !== undefined && Math.abs(tShape.rise - 3) < 0.3, JSON.stringify(tShape));
});
