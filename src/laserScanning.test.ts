import assert from "node:assert/strict";
import { test } from "node:test";
import { mapSheet, roofOf } from "./laserScanning.ts";

test("mapSheet names the 1:5000 sheet a point is in", () => {
  // a sheet's corners, 326 000 .. 329 000 E and 6 822 000 .. 6 825 000 N, as its point cloud's header has them
  assert.equal(mapSheet(328111, 6822884), "M4212G1");
  assert.equal(mapSheet(326000, 6822000), "M4212G1");
  assert.equal(mapSheet(328999.9, 6824999.9), "M4212G1");
  // its neighbours east, north and west
  assert.equal(mapSheet(329000, 6822000), "M4212G3");
  assert.equal(mapSheet(326000, 6825000), "M4212G2");
  assert.equal(mapSheet(325999, 6822000), "M4212E3");
  assert.throws(() => mapSheet(300000, 6500000));
});

test("roofOf is the height under nearly all the points over the ground, what stands on a small part left out", () => {
  // a ridge at 113 m over slopes down to 105 m, and a lantern up to 116.4 m
  const slopes = Array.from({ length: 200 }, (_, i) => 105 + (8 * i) / 199);
  assert.equal(roofOf([...slopes, 116.4, 115.2, 114.7], 3), slopes[Math.floor(0.98 * 202)]);
  // too few points, or too many on the ground: a building newer than the scanning
  assert.equal(roofOf([110, 111, 112], 0), undefined);
  assert.equal(roofOf(slopes.slice(0, 20), 10), undefined);
});
