import assert from "node:assert/strict";
import { test } from "node:test";
import { clipPolyline, clipRing, orientedBox, pointInPolygon, ringArea, simplifyLine, simplifyRing, stitchRings, triangulate, type Point } from "./geometry.ts";
import { defined } from "./testing.ts";

const rect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

test("clipPolyline cuts a line at the rectangle edges", () => {
  assert.deepEqual(clipPolyline([[-5, 5], [5, 5], [15, 5]], rect), [[[0, 5], [5, 5], [10, 5]]]);
});

test("clipPolyline splits a line that leaves and comes back", () => {
  const line: Point[] = [[2, 2], [2, 20], [8, 20], [8, 2]];
  assert.deepEqual(clipPolyline(line, rect), [
    [[2, 2], [2, 10]],
    [[8, 10], [8, 2]],
  ]);
});

test("clipPolyline drops lines outside and lines that only touch a corner", () => {
  assert.deepEqual(clipPolyline([[20, 20], [30, 30]], rect), []);
  assert.deepEqual(clipPolyline([[-5, 5], [5, 15]], rect), []);
});

test("clipRing clips a polygon to the rectangle", () => {
  const clipped = defined(clipRing([[-5, -5], [5, -5], [5, 5], [-5, 5]], rect));
  assert.equal(ringArea(clipped), 25);
});

test("clipRing returns undefined for a ring outside", () => {
  assert.equal(clipRing([[20, 20], [30, 20], [30, 30]], rect), undefined);
});

test("stitchRings joins ways into closed rings, reversing ways as needed", () => {
  const same = (a: string, b: string) => a === b;
  const { rings, unclosed } = stitchRings([["a", "b"], ["c", "b"], ["c", "d", "a"], ["x", "y"]], same);
  assert.deepEqual(rings, [["c", "d", "a", "b"]]);
  assert.equal(unclosed, 1);
});

test("pointInPolygon honours holes", () => {
  const outer: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole: Point[] = [[4, 4], [6, 4], [6, 6], [4, 6]];
  const polygon = { outer, holes: [hole] };
  assert.equal(pointInPolygon([2, 2], polygon), true);
  assert.equal(pointInPolygon([5, 5], polygon), false);
  assert.equal(pointInPolygon([12, 5], polygon), false);
});

test("simplifyLine drops points closer than the tolerance", () => {
  assert.deepEqual(simplifyLine([[0, 0], [5, 0.1], [10, 0], [10, 10]], 0.5), [[0, 0], [10, 0], [10, 10]]);
});

test("simplifyRing keeps the shape of a ring", () => {
  const ring: Point[] = [[0, 0], [5, 0.05], [10, 0], [10, 10], [0, 10]];
  assert.deepEqual(simplifyRing(ring, 0.25), [[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test("triangulate covers a polygon with a hole", () => {
  const outer: Point[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole: Point[] = [[4, 4], [4, 6], [6, 6], [6, 4]];
  const indices = triangulate({ outer, holes: [hole] });
  const vertices = [...outer, ...hole];
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    area += Math.abs(ringArea([vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]]]));
  }
  assert.equal(indices.length, 8 * 3);
  assert.equal(area, 100 - 4);
});

test("orientedBox finds a turned rectangle's long side", () => {
  // 8 x 2, turned 30 degrees counter-clockwise
  const turn = (x: number, y: number): Point => [x * Math.cos(Math.PI / 6) - y * Math.sin(Math.PI / 6), x * Math.sin(Math.PI / 6) + y * Math.cos(Math.PI / 6)];
  const box = orientedBox([turn(0, 0), turn(8, 0), turn(8, 2), turn(0, 2)]);
  assert.deepEqual([((box.angle * 180) / Math.PI).toFixed(1), box.length.toFixed(3), box.width.toFixed(3)], ["30.0", "8.000", "2.000"]);
  // the long side north-south
  assert.equal(((orientedBox([[0, 0], [2, 0], [2, 8], [0, 8]]).angle * 180) / Math.PI).toFixed(1), "90.0");
});
