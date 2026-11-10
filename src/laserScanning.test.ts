import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchLaserRoofs, mapSheet, roofOf } from "./laserScanning.ts";
import { memoryCache } from "./cache.ts";
import type { Polygon } from "./geometry.ts";
import { outlineKey } from "./ortho.ts";

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

test("the cached roofs come with the shape chosen from their fits, and need no sheet fetched", async () => {
  const square = (e: number, n: number): Polygon => ({ outer: [[e, n], [e + 20, n], [e + 20, n + 10], [e, n + 10]], holes: [] });
  // three outlines in sheet L4144B4 (Tampere's centre)
  const outlines = [square(327000, 6822000), square(327100, 6822000), square(327200, 6822000)];
  const cache = memoryCache();
  const sheet = mapSheet(327010, 6822005);
  const [gabled, flat, none] = outlines.map(outlineKey);
  await cache.put(`mml-laser-roofs-${sheet}.json`, JSON.stringify({ version: 3, roofs: { [gabled]: [104, "flat", 0, 0, 103.6, 0.6, 0, "gabled", 90, 3.2, 104.5, 0.05, 0.4], [flat]: 99.5, [none]: null } }));
  const result = await fetchLaserRoofs(outlines, { cache, refresh: false, apiKey: "-" });
  assert.deepEqual([result.cached, result.fetched], [3, 0]);
  assert.deepEqual([...result.roofs], [[0, 104], [1, 99.5]]);
  assert.deepEqual([...result.shapes], [[0, { shape: "gabled", angle: 90, rise: 3.2, top: 104.5 }]]);
});

test("a sheet whose fetch fails leaves out only the roofs needing it", async (t) => {
  const square = (e: number, n: number): Polygon => ({ outer: [[e, n], [e + 20, n], [e + 20, n + 10], [e, n + 10]], holes: [] });
  // one outline cached, one in a sheet 6 km off that is not
  const outlines = [square(327000, 6822000), square(333000, 6822000)];
  const cache = memoryCache();
  await cache.put(`mml-laser-roofs-${mapSheet(327010, 6822005)}.json`, JSON.stringify({ version: 3, roofs: { [outlineKey(outlines[0])]: 104 } }));
  t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("no network")));
  const logged: string[] = [];
  const result = await fetchLaserRoofs(outlines, { cache, refresh: false, apiKey: "-", log: (m) => logged.push(m) });
  assert.deepEqual([result.cached, result.fetched, result.failed], [1, 0, 1]);
  assert.deepEqual([...result.roofs], [[0, 104]]);
  assert.ok(logged.some((m) => /failed, its roofs left out: no network/.test(m)), logged.join("\n"));
  // nothing cached for it: fetched another time
  assert.equal(await cache.get(`mml-laser-roofs-${mapSheet(333010, 6822005)}.json`), undefined);
});
