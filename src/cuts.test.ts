import assert from "node:assert/strict";
import { test } from "node:test";
import { coverCutTunnels, cutLid, fitLidsToDecks } from "./cuts.ts";
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
  const features: MapFeatures = { roads: [street], rails: [tram, railway, deep], buildings: [station], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], bridgeDecks: [] };
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

test("a tunnel beside one in a cut is in the same cut, under the same lid", () => {
  // the pavement 5 m beside the tramway is not in a cut of its own in the elevation model (it has the
  // platform over it, 101), only beside the tramway's
  const tram = rail("w1", [[10, 0], [60, 0]], { kind: "light_rail", layer: -1, tunnel: true });
  const pavement = road("w2", [[10, -5], [60, -5]], { kind: "footway", width: 2.5, layer: -1, tunnel: true });
  const apart = road("w3", [[10, -40], [60, -40]], { kind: "footway", width: 2.5, layer: -1, tunnel: true });
  const features: MapFeatures = { roads: [pavement, apart], rails: [tram], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], bridgeDecks: [] };
  const wide = (e: number, n: number) => (e >= 0 && Math.abs(n) <= 4 ? 95 : e >= 0 && n < -4 && n > -7 ? 101 : 102);
  assert.equal(cutLid(pavement.line, wide), undefined);
  assert.equal(coverCutTunnels(features, wide).tunnels, 2);
  assert.deepEqual(pavement.lid, tram.lid);
  // on the cut's floor beside it, not on the platform's edge it is mapped on
  assert.deepEqual(pavement.floor, [95, 95]);
  assert.equal(apart.lid, undefined);
});

test("a tunnel in a cut has a floor at the cut's bottom, not on the cut's side the elevation model has under it", () => {
  // the cut's bottom at 95 within 2 m of n = 0, its sides rising to 102 at 6 m
  const sloped = (e: number, n: number) => (e < 0 ? 102 : Math.min(102, 95 + Math.max(0, Math.abs(n) - 2) * 1.75));
  // the tram mapped 3.5 m off the middle, where the side is at 97.6; its ends where it leads on, on the ground
  const tram = rail("w1", [[10, 3.5], [30, 3.5], [45, 3.5], [60, 3.5]], { kind: "light_rail", layer: -1, tunnel: true });
  const features: MapFeatures = { roads: [], rails: [tram], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], bridgeDecks: [] };
  coverCutTunnels(features, sloped);
  assert.deepEqual(tram.floor, [sloped(10, 3.5), 95, 95, sloped(60, 3.5)]);
});

test("fitLidsToDecks lowers a lid to the decks of the bridges over it, leaving room under it", () => {
  const underpass = road("w1", [[0, 0], [20, 0]], { kind: "cycleway", width: 2.5, layer: -1, tunnel: true, lid: [105.3, 105.3], floor: [100.8, 100.8] });
  const street = road("w2", [[10, -5], [10, 5]], { bridge: true, deck: [104.5, 104.5] });
  const low = road("w3", [[0, 10], [20, 10]], { kind: "footway", width: 2.5, layer: -1, tunnel: true, lid: [105.3, 105.3], floor: [100.8, 100.8] });
  const lowStreet = road("w4", [[10, 5], [10, 15]], { bridge: true, deck: [102, 102] });
  fitLidsToDecks([underpass, street, low, lowStreet]);
  assert.deepEqual(underpass.lid, [104.5, 104.5]);
  // no lower than 2.5 m of room and the lid over the floor
  assert.deepEqual(low.lid, [100.8 + 2.5 + 1, 100.8 + 2.5 + 1]);
});
