import assert from "node:assert/strict";
import { test } from "node:test";
import { fitGambrel, gambrelFaces, GAMBREL_REACH_M, isGambrel, kneeShare } from "./gambrelRoofs.ts";
import { distanceToRing, pointInRing, ringArea, type Point, type Polygon } from "./geometry.ts";
import { applyLaserShapes, chooseRoofShape } from "./laserRoofShapes.ts";
import type { Building } from "./osm.ts";

// a house 14 m by 9.5 m, its long side at 50° from east, centred at (1000, 2000)
const ANGLE = (50 * Math.PI) / 180;
const [CX, CY] = [1000, 2000];
const toWorld = (u: number, v: number): Point => [CX + u * Math.cos(ANGLE) - v * Math.sin(ANGLE), CY + u * Math.sin(ANGLE) + v * Math.cos(ANGLE)];
const OUTLINE: Polygon = { outer: [toWorld(-7, -4.75), toWorld(7, -4.75), toWorld(7, 4.75), toWorld(-7, 4.75)], holes: [] };

/**
 * Half a point a square metre over the ground near the outline (GAMBREL_REACH_M), at the heights z(u, v) gives, a
 * little noisy, where z gives any; with a chimney's points
 */
function scan(z: (u: number, v: number) => number | undefined, seed = 7): [number, number, number][] {
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const points: [number, number, number][] = [];
  const [a, b] = [7 + GAMBREL_REACH_M, 4.75 + GAMBREL_REACH_M];
  for (let i = 0; i < 0.5 * 4 * a * b; i++) {
    const [u, v] = [(2 * random() - 1) * a, (2 * random() - 1) * b];
    const height = z(u, v);
    const p = toWorld(u, v);
    if (height !== undefined && (pointInRing(p, OUTLINE.outer) || distanceToRing(p, OUTLINE.outer) <= GAMBREL_REACH_M)) {
      points.push([...p, height + (random() - 0.5) * 0.15]);
    }
  }
  for (const [u, v] of [[3, 1], [3.3, 1.2]]) {
    const height = z(u, v);
    if (height !== undefined) {
      points.push([...toWorld(u, v), height + 1.2]);
    }
  }
  return points;
}

/** A gambrel roof whose ridge lies off the outline's middle by off (m): 22° to the knee 3.3 m out, then 65° to the eaves */
const gambrel =
  (off: number) =>
  (u: number, v: number): number | undefined => {
    const d = Math.abs(v - off);
    if (Math.abs(u) > 7.4 || d > 5.1) {
      return undefined;
    }
    const [upper, lower] = [Math.tan((22 * Math.PI) / 180), Math.tan((65 * Math.PI) / 180)];
    return 127.4 - upper * Math.min(d, 3.3) - lower * Math.max(d - 3.3, 0);
  };

test("a gambrel roof is told from its points, its ridge found off the outline's middle", () => {
  const fit = fitGambrel(scan(gambrel(-0.7)), OUTLINE);
  assert.ok(fit && isGambrel(fit), JSON.stringify(fit));
  assert.equal(fit.angle, 0);
  assert.ok(Math.abs(fit.offset + 0.7) <= 0.25, JSON.stringify(fit));
  assert.ok(Math.abs(fit.knee * 4.75 - 3.3) < 0.5 && Math.abs(fit.top - 127.4) < 0.2, JSON.stringify(fit));
  assert.ok(Math.abs((Math.atan(fit.slope) * 180) / Math.PI - 22) < 4 && Math.abs((Math.atan(fit.lowerSlope) * 180) / Math.PI - 65) < 10, JSON.stringify(fit));
  // chosen over whatever else fits, as a gabled roof that is a gambrel one
  const shape = chooseRoofShape([], fit);
  assert.ok(shape && shape.shape === "gabled" && shape.gambrel && Math.abs(shape.gambrel.height - kneeShare(fit)) < 0.001, JSON.stringify(shape));
});

test("a gabled roof, a flat one by a lower wing, and too few points are no gambrel roof", () => {
  const gabled = fitGambrel(
    scan((u, v) => (Math.abs(u) <= 7.4 && Math.abs(v) <= 5.1 ? 127 - 0.7 * Math.abs(v) : undefined)),
    OUTLINE,
  );
  assert.ok(gabled && !isGambrel(gabled), JSON.stringify(gabled));
  // a nearly flat roof, its outline reaching over a lower roof beside it
  const flat = fitGambrel(
    scan((u, v) => (Math.abs(u) > 7.4 ? undefined : v < 3.5 ? 120 - 0.05 * Math.abs(v) : 116)),
    OUTLINE,
  );
  assert.ok(!flat || !isGambrel(flat), JSON.stringify(flat));
  assert.equal(fitGambrel(scan(gambrel(0)).slice(0, 10), OUTLINE), undefined);
  // an outline with a hole, or far from its box, is fitted none
  assert.equal(fitGambrel(scan(gambrel(0)), { ...OUTLINE, holes: [[toWorld(-1, -1), toWorld(1, -1), toWorld(1, 1)]] }), undefined);
});

test("a gambrel roof's faces cover its outline, the knee's share of the height along the gable ends", () => {
  // 10 m by 8, the ridge east to west
  const outer: Point[] = [[0, 0], [10, 0], [10, 8], [0, 8]];
  const faces = gambrelFaces(outer, 0, 0.6, 0.75);
  let area = 0;
  for (let t = 0; t < faces.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => faces.triangles[t + k]).map((i): Point => [faces.points[3 * i], faces.points[3 * i + 1]]);
    area += Math.abs(ringArea([a, b, c]));
  }
  assert.ok(Math.abs(area - 80) < 1e-6, String(area));
  const shareAt = (e: number, n: number) => {
    for (let i = 0; i < faces.points.length; i += 3) {
      if (Math.abs(faces.points[i] - e) < 1e-6 && Math.abs(faces.points[i + 1] - n) < 1e-6) {
        return faces.points[i + 2];
      }
    }
    return undefined;
  };
  // the eaves, the knees 0.6 of the way out from the ridge, and the ridge on the west gable
  assert.deepEqual([0, 1.6, 4, 6.4, 8].map((n) => shareAt(0, n)), [0, 0.75, 1, 0.75, 0]);
});

test("a building given a gambrel roof is drawn by its faces, with a storey in the roof that its walls had too low", () => {
  const b: Building = {
    osm: "w3",
    kind: "house",
    part: false,
    hasParts: false,
    height: 8.5,
    minHeight: 0,
    base: 119,
    levels: 2,
    roofShapeEstimated: true,
    roofShape: "gabled",
    roofHeightEstimated: true,
    polygon: { outer: [[0, 0], [14, 0], [14, 9.5], [0, 9.5]], holes: [] },
  };
  const result = applyLaserShapes([b], () => ({ shape: "gabled", angle: 0, rise: 4.6, top: 127.5, gambrel: { knee: 0.7, height: 0.65 } }));
  assert.deepEqual(result, { pitched: 1, flattened: 0, gambrel: 1 });
  assert.ok(b.roofFaces && b.roofFaces.triangles.length >= 12, JSON.stringify(b.roofFaces));
  assert.deepEqual([b.roofShape, b.roofAngle, b.roofHeight, b.levels, b.roofLevels], [undefined, undefined, 4.6, 1, 1]);
});
