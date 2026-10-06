import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { Rail, Road } from "./osm.ts";
import { lowerUnderBridges } from "./underbridges.ts";

function road(osm: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind: "residential", width: 6, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

// a road bridge along e at n = 0, its deck level at 100, over ground at 98
const bridge = () => road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, deck: [100, 100] });

test("a way under a bridge too low over it goes down into a cut under it, the deck staying straight", () => {
  const deck = bridge();
  const path = road("w2", [[0, -60], [0, 60]], { kind: "footway", width: 2.5 });
  const ways = [deck, path];
  assert.equal(lowerUnderBridges(ways, [deck], [], () => 98), 1);
  assert.deepEqual(deck.deck, [100, 100]);
  // the room for people (2.7 m) and the deck's 1 m under the deck: 96.3, ramping up at 8 % to the ground
  const cut = ways.find((w) => w.osm === "w2" && w.floor);
  assert.ok(cut?.floor);
  assert.ok(Math.abs(Math.min(...cut.floor) - 96.3) < 1e-9);
  assert.ok(Math.abs(cut.floor[0] - 98) < 0.05 && Math.abs(cut.floor[cut.floor.length - 1] - 98) < 0.05);
  // under the deck (its 6 m, 0.5 m edges and a meter more) at the bottom; the ramps 1.7 m / 8 % long
  const n = cut.line.map(([, y]) => y);
  assert.ok(Math.min(...n) < -5 - 1.7 / 0.08 + 2 && Math.max(...n) > 5 + 1.7 / 0.08 - 2);
  assert.equal(ways.filter((w) => w.osm === "w2").length, 3);
});

test("a way that would go deeper than 3 m, or ends under the bridge, is left as it is", () => {
  const deck = bridge();
  const deep = road("w2", [[0, -60], [0, 60]], { kind: "primary" });
  const ending = road("w3", [[10, -60], [10, 1]], { kind: "footway", width: 2.5 });
  const ways = [deck, deep, ending];
  // a road needs 4.2 m and the deck's 1 m: 94.8, 4.2 m under the ground at 99
  assert.equal(lowerUnderBridges(ways, [deck], [], () => 99), 0);
  assert.equal(ways.length, 3);
  assert.equal(ending.floor, undefined);
});

test("ways joined end to end under a bridge go down as one, across where they meet", () => {
  const deck = bridge();
  // a tramway in two ways meeting under the bridge
  const a: Rail = { osm: "w2", kind: "tram", layer: 0, bridge: false, tunnel: false, line: [[0, -120], [0, 1]] };
  const b: Rail = { osm: "w3", kind: "tram", layer: 0, bridge: false, tunnel: false, line: [[0, 1], [0, 120]] };
  const rails = [a, b];
  // a tram needs 4.7 m and the deck's 1 m: 94.3, 3.7 m under the ground at 98 is too deep; at 97 it is 2.7 m
  assert.equal(lowerUnderBridges(rails, [deck], [], () => 97), 1);
  const floors = rails.filter((r) => r.floor);
  assert.equal(floors.length, 2);
  // they meet at the same height
  const ofA = floors.find((r) => r.osm === "w2");
  const ofB = floors.find((r) => r.osm === "w3");
  assert.ok(ofA?.floor && ofB?.floor);
  assert.ok(Math.abs(ofA.floor[ofA.floor.length - 1] - ofB.floor[0]) < 1e-9);
});

test("a way meeting another in the cut it would need is left as it is", () => {
  const deck = bridge();
  const path = road("w2", [[0, -60], [0, -10], [0, 60]], { kind: "footway", width: 2.5 });
  // a path across it 10 m from the bridge, where its ramp would be
  const across = road("w3", [[-20, -10], [0, -10], [20, -10]], { kind: "footway", width: 2.5 });
  const ways = [deck, path, across];
  assert.equal(lowerUnderBridges(ways, [deck], [], () => 98), 0);
  assert.equal(path.floor, undefined);
});
