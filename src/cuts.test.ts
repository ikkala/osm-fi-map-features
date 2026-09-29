import assert from "node:assert/strict";
import { test } from "node:test";
import { coverCutTunnels, cutLid } from "./cuts.ts";
import type { Point } from "./geometry.ts";
import type { Building, MapFeatures, Rail, Road } from "./osm.ts";

// ground at 102 with a cut to 95 along n = 0 (up to 4 m either side), east of e = 0
const cut = (e: number, n: number) => (e >= 0 && Math.abs(n) <= 4 ? 95 : 102);
// a hill: the ground is at 110 over a tunnel under it
const hill = () => 110;

function rail(osm: string, line: Point[], extra: Partial<Rail> = {}): Rail {
  return { osm, kind: "rail", layer: 0, bridge: false, tunnel: false, line, ...extra };
}

function road(osm: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind: "residential", width: 6, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

test("cutLid covers a tunnel in a cut at the ground beside it, and not one under a hill", () => {
  assert.deepEqual(cutLid([[10, 0], [50, 0]], cut), [102, 102]);
  assert.equal(cutLid([[10, 0], [50, 0]], hill), undefined);
});

test("cutLid leaves room for vehicles under a lid over a shallow cut", () => {
  const shallow = (e: number, n: number) => (Math.abs(n) <= 4 ? 95 : 99);
  assert.deepEqual(cutLid([[10, 0], [50, 0]], shallow), [95 + 3.5 + 1, 95 + 3.5 + 1]);
});

test("coverCutTunnels gives the tunnel a lid, makes the ways over it bridges and opens walls over it", () => {
  const tram = rail("w1", [[10, 0], [60, 0]], { kind: "light_rail", layer: -1, tunnel: true });
  // a railway over the tunnel, a street leading on from its portal, and a deep tunnel
  const railway = rail("w2", [[30, -40], [30, 40]]);
  const street = road("w3", [[60, 0], [80, 10]]);
  const deep = rail("w4", [[10, 2], [60, 2]], { layer: -2, tunnel: true });
  const outer: Point[] = [[40, -10], [50, -10], [50, 10], [40, 10]];
  const station: Building = { osm: "w5", kind: "train_station", part: false, hasParts: false, height: 10, minHeight: 0, polygon: { outer, holes: [] } };
  const features: MapFeatures = { roads: [street], rails: [tram, railway, deep], buildings: [station], areas: [], trees: [], lamps: [] };
  assert.deepEqual(coverCutTunnels(features, cut), { tunnels: 1, crossings: 1 });
  assert.deepEqual(tram.lid, [102, 102]);
  assert.equal(deep.lid, undefined);
  // the railway is split where it crosses the lid (7.5 m either way: half the tram's 3 m and the lid's edges)
  const pieces = features.rails.filter((r) => r.osm === "w2");
  assert.deepEqual(
    pieces.map((r) => [r.line[0][1], r.line[r.line.length - 1][1], r.bridge]),
    [[-40, -3.5, false], [-3.5, 3.5, true], [3.5, 40, false]],
  );
  assert.deepEqual([street.bridge, street.line.length], [false, 2]);
  // the station's walls are open over the tunnel, below its floor
  assert.deepEqual(station.passages?.map((o) => o.height), [0, 0]);
});
