import assert from "node:assert/strict";
import { test } from "node:test";
import { leaveOutOnDecks, openBarriers } from "./barriers.ts";
import type { Point } from "./geometry.ts";
import type { Barrier, MapFeatures, Road } from "./osm.ts";
import { placeStreetNodes } from "./streets.ts";

function road(osm: string, kind: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind, width: 8, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

function fence(osm: string, line: Point[]): Barrier {
  return { osm, kind: "fence", height: 1.2, line };
}

function features(roads: Road[], barriers: Barrier[] = []): MapFeatures {
  return { roads, rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers, playEquipment: [], bridgeDecks: [] };
}

test("a crossing and a traffic signal go on the street, not on the footway across it", () => {
  const map = features([road("w1", "footway", [[50, -20], [50, 20]], { width: 2 }), road("w2", "tertiary", [[100, 0], [0, 0]], { width: 7 })]);
  const { dropped } = placeStreetNodes(
    [
      { kind: "crossing", point: [50, 0] },
      { kind: "signal", point: [60, 0.4], direction: "forward" },
      // on the footway only
      { kind: "crossing", point: [50, 15] },
    ],
    map,
  );
  assert.equal(dropped, 1);
  assert.deepEqual(map.crossings.map((c) => [c.along, c.kind, c.width]), [[180, "tertiary", 7]]);
  assert.deepEqual(map.signals.map((s) => [s.point, s.along, s.direction]), [[[60, 0.4], 180, "forward"]]);
});

test("a traffic signal on a one-way road is for its traffic only, unless tagged otherwise", () => {
  const map = features([
    road("w1", "unclassified", [[0, 0], [100, 0]], { oneway: 1 }),
    road("w2", "unclassified", [[0, 20], [100, 20]], { oneway: -1 }),
    road("w3", "unclassified", [[0, 40], [100, 40]]),
  ]);
  placeStreetNodes(
    [
      { kind: "signal", point: [50, 0] },
      { kind: "signal", point: [60, 0], direction: "backward" },
      { kind: "signal", point: [50, 20] },
      { kind: "signal", point: [50, 40] },
    ],
    map,
  );
  assert.deepEqual(map.signals.map((s) => s.direction), ["forward", "backward", "backward", undefined]);
});

test("a gate spans the way it is on, or lies in its fence, and a crossing on a bridge gets the deck's height", () => {
  const bridge = road("w3", "residential", [[0, 50], [100, 50]], { bridge: true, deck: [100, 110] });
  const map = features([road("w1", "service", [[0, 0], [0, 100]], { width: 4 }), bridge], [fence("w2", [[20, 0], [20, 40]])]);
  placeStreetNodes(
    [
      { kind: "gate", point: [0, 30] },
      { kind: "gate", point: [20, 10], width: 1 },
      { kind: "gate", point: [60, 60] },
      { kind: "crossing", point: [50, 50] },
    ],
    map,
  );
  assert.deepEqual(map.gates.map((g) => [g.point, g.across, g.width]), [[[0, 30], 180, 4], [[20, 10], 90, 1]]);
  assert.equal(map.crossings[0].base, 105);
});

test("fences open where ways cross them and at their gates, but not for bridges or tunnels", () => {
  const map = features(
    [
      road("w1", "footway", [[10, -5], [10, 5]], { width: 2 }),
      road("w2", "primary", [[30, -5], [30, 5]], { bridge: true }),
      road("w3", "primary", [[40, -5], [40, 5]], { tunnel: true }),
    ],
    [fence("w4", [[0, 0], [100, 0]])],
  );
  map.gates.push({ point: [70, 0.5], across: 0, width: 3 });
  assert.equal(openBarriers(map), 2);
  // the footway's 2 m and a 0.4 m margin, and the gate's 3 m
  assert.deepEqual(
    map.barriers.map((b) => b.line.map(([e]) => Math.round(e * 10) / 10)),
    [[0, 8.8], [11.2, 68.5], [71.5, 100]],
  );
  assert.ok(map.barriers.every((b) => b.osm === "w4"));
});

test("leaveOutOnDecks leaves out a barrier's stretch on a bridge's deck or a tunnel's lid, over the ground", () => {
  // a railing along a bridge 4 m over the ground between e = 20 and 40, and on along the ground beyond
  const bridge = road("w1", "primary", [[20, 0], [40, 0]], { bridge: true, deck: [104, 104] });
  const lidded = road("w2", "cycleway", [[60, -20], [60, 20]], { width: 2.5, tunnel: true, lid: [104, 104] });
  const railing = fence("w3", [[0, 4.5], [80, 4.5]]);
  const map: MapFeatures = { roads: [bridge, lidded], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [railing], playEquipment: [], bridgeDecks: [] };
  assert.equal(leaveOutOnDecks(map, () => 100), 2);
  // the deck reaches 4 m and its edge 0.5 m out, the lid 1.25 m and its edges 2 m: 1.5 m more on both, round its
  // ends too (sampled every meter)
  assert.deepEqual(
    map.barriers.map((b) => b.line.map(([e]) => Math.round(e))),
    [[0, 17], [44, 56], [65, 80]],
  );
});
