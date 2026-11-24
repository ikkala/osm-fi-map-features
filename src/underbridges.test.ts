import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "./geometry.ts";
import type { BridgeDeck, BridgeOutline, Rail, Road } from "./osm.ts";
import { leastDecks, lowerUnderBridges } from "./underbridges.ts";
import { DECK_THICKNESS_M } from "./ways.ts";

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
  // its room in the cut that much, so its roof stays under the deck
  assert.equal(cut.room, 2.7);
  assert.ok(Math.abs(cut.floor[0] - 98) < 0.05 && Math.abs(cut.floor[cut.floor.length - 1] - 98) < 0.05);
  // under the deck (its 6 m, 0.5 m edges and a meter more) at the bottom; the ramps 1.7 m / 8 % long
  const n = cut.line.map(([, y]) => y);
  assert.ok(Math.min(...n) < -5 - 1.7 / 0.08 + 2 && Math.max(...n) > 5 + 1.7 / 0.08 - 2);
  assert.equal(ways.filter((w) => w.osm === "w2").length, 3);
});

test("a cut's ramps ease out of its bottom, with only the points its floor's shape needs: it bends no more than 0.16 m from the line 10 m either side", () => {
  for (const [kind, width] of [["footway", 2.5], ["primary", 6]] as const) {
    const deck = bridge();
    const way = road("w2", [[0, -100], [0, 100]], { kind, width });
    const ways = [deck, way];
    lowerUnderBridges(ways, [deck], [], () => 98.5);
    const cut = ways.find((w) => w.osm === "w2" && w.floor);
    assert.ok(cut?.floor);
    // none along the ramps at their grade, a few where they ease
    assert.ok(cut.line.length <= 16, `${kind}: ${cut.line.length} points`);
    const floor = cut.floor;
    const n = cut.line.map(([, y]) => y);
    const at = (y: number) => {
      const i = n.findIndex((v, k) => k + 1 < n.length && v <= y && n[k + 1] >= y);
      return floor[i] + ((floor[i + 1] - floor[i]) * (y - n[i])) / (n[i + 1] - n[i] || 1);
    };
    for (let y = n[0] + 10; y <= n[n.length - 1] - 10; y += 0.5) {
      assert.ok(Math.abs(at(y) - (at(y - 10) + at(y + 10)) / 2) <= 0.16 + 1e-6, `${kind} at ${y}`);
    }
  }
});

test("a cut whose eased ramps would reach a junction has its ramps rise at once at the grade instead", () => {
  const deck = bridge();
  // 1.7 m down for a person's room: ramps at 8 % end 21 m past the bottom, eased ones 34 m
  const path = road("w2", [[0, -60], [0, 32], [0, 60]], { kind: "footway", width: 2.5 });
  const street = road("w3", [[-30, 32], [0, 32], [30, 32]]);
  const ways = [deck, path, street];
  assert.equal(lowerUnderBridges(ways, [deck], [], () => 98), 1);
  const cut = ways.find((w) => w.osm === "w2" && w.floor);
  assert.ok(cut?.floor);
  assert.ok(Math.abs(Math.min(...cut.floor) - 96.3) < 1e-9);
  assert.ok(Math.max(...cut.line.map(([, n]) => n)) < 32);
  assert.equal(street.floor, undefined);
});

test("under an outline the deck is the one built there: lower than its bridge way's, or none where it is left open", () => {
  // the outline from n = -20 to 20 over e -10 to 10, its deck built only north of the bridge way, at 99.5
  const outline: BridgeOutline = { osm: "w9", polygon: { outer: [[-10, -20], [10, -20], [10, 20], [-10, 20]], holes: [] } };
  const built: BridgeDeck = { osm: "w9", vertices: [[-10, 10], [10, 10], [10, 20], [-10, 20]], triangles: [0, 1, 2, 0, 2, 3], heights: [99.5, 99.5, 99.5, 99.5] };
  const path = () => road("w2", [[-60, 15], [60, 15]], { kind: "footway", width: 2.5 });
  const high = () => road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, deck: [102, 102] });
  // the bridge way's deck 4 m over the ground leaves the path room enough; the deck built over it 1.5 m does not
  const under = [high(), path()];
  assert.equal(lowerUnderBridges(under, [under[0]], [outline], () => 98), 0);
  const cut = [high(), path()];
  assert.equal(lowerUnderBridges(cut, [cut[0]], [outline], () => 98, undefined, undefined, [built]), 1);
  const floor = cut.find((w) => w.osm === "w2" && w.floor)?.floor;
  assert.ok(floor && Math.abs(Math.min(...floor) - (99.5 - 1 - 2.7)) < 1e-9);
  // south of the bridge way the outline has no deck: a path there under it stays as it is
  const low = () => road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, deck: [100, 100] });
  const south = () => road("w3", [[-60, -15], [60, -15]], { kind: "footway", width: 2.5 });
  const open = [low(), south()];
  assert.equal(lowerUnderBridges(open, [open[0]], [outline], () => 98), 1);
  const left = [low(), south()];
  assert.equal(lowerUnderBridges(left, [left[0]], [outline], () => 98, undefined, undefined, [built]), 0);
});

test("a way whose room would need a cut deeper than 3 m goes down 3 m even where that leaves it less than a bus's; one ending under the bridge is left as it is", () => {
  const deck = bridge();
  const deep = road("w2", [[0, -60], [0, 60]], { kind: "primary" });
  const ending = road("w3", [[10, -60], [10, 1]], { kind: "footway", width: 2.5 });
  const ways = [deck, deep, ending];
  // a road needs 4.2 m and the deck's 1 m: 94.8, 4.2 m under the ground at 99; 3 m deep, at 96, it has 3 m
  assert.equal(lowerUnderBridges(ways, [deck], [], () => 99), 1);
  const cut = ways.find((w) => w.osm === "w2" && w.floor);
  assert.ok(cut?.floor && cut.room !== undefined);
  assert.ok(Math.abs(Math.min(...cut.floor) - 96) < 1e-9);
  assert.ok(Math.abs(cut.room - 3) < 1e-9);
  assert.equal(ending.floor, undefined);
});

test("a way whose room would need a cut deeper than 3 m goes down 3 m where that leaves it the least room of its kind", () => {
  const deck = bridge();
  const road2 = road("w2", [[0, -80], [0, 80]], { kind: "primary" });
  const ways = [deck, road2];
  // the deck's underside at 99, 0.5 m over the ground at 98.5: 4.2 m of room would need a cut 4.7 m deep; 3 m deep,
  // at 95.5, it leaves 3.5 m, a bus's
  assert.equal(lowerUnderBridges(ways, [deck], [], () => 98.5), 1);
  const cut = ways.find((w) => w.osm === "w2" && w.floor);
  assert.ok(cut?.floor);
  assert.ok(Math.abs(Math.min(...cut.floor) - 95.5) < 1e-9);
  // its room the one left under the deck
  assert.ok(cut.room !== undefined && Math.abs(cut.room - 3.5) < 1e-9);
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

test("a way meeting a road or a way of another layer in the cut it would need is left as it is", () => {
  const deck = bridge();
  const path = road("w2", [[0, -60], [0, -10], [0, 60]], { kind: "footway", width: 2.5 });
  // a street across it 10 m from the bridge, where its ramp would be, and a path on another layer at its other ramp
  const across = road("w3", [[-20, -10], [0, -10], [20, -10]]);
  assert.equal(lowerUnderBridges([deck, path, across], [deck], [], () => 98), 0);
  assert.equal(path.floor, undefined);
  const other = road("w4", [[0, -60], [0, 10], [0, 60]], { kind: "footway", width: 2.5 });
  const above = road("w5", [[-20, 10], [0, 10], [20, 10]], { kind: "footway", width: 2.5, layer: 1 });
  assert.equal(lowerUnderBridges([deck, other, above], [deck], [], () => 98), 0);
});

test("paths meeting under a bridge go down together, at one height where they meet", () => {
  const deck = bridge();
  const path = road("w2", [[0, -60], [0, 2], [0, 12], [0, 60]], { kind: "footway", width: 2.5 });
  // a cycleway joining it under the deck, and a footway across it where its ramp is
  const joining = road("w3", [[0, 2], [80, 2]], { kind: "cycleway", width: 3 });
  const across = road("w4", [[-40, 12], [0, 12], [40, 12]], { kind: "footway", width: 2.5 });
  const ways = [deck, path, joining, across];
  assert.equal(lowerUnderBridges(ways, [deck], [], () => 98), 1);
  const floorAt = (osm: string, p: Point) => {
    for (const way of ways.filter((w) => w.osm === osm && w.floor)) {
      const i = way.line.findIndex(([e, n]) => e === p[0] && n === p[1]);
      if (i >= 0 && way.floor) {
        return way.floor[i];
      }
    }
    return undefined;
  };
  // at the bottom under the deck where they meet (its last sample under it 4 m from its middle), the one crossing
  // the ramp at the ramp's height there, 8 m out of the bottom, where it is still easing into its grade
  assert.ok(Math.abs((floorAt("w2", [0, 2]) ?? 0) - 96.3) < 1e-9);
  assert.equal(floorAt("w3", [0, 2]), floorAt("w2", [0, 2]));
  const crossing = floorAt("w4", [0, 12]);
  assert.ok(crossing !== undefined && Math.abs(crossing - (96.3 + 0.0012 * (12 - 4) ** 2)) < 1e-9);
  assert.equal(floorAt("w2", [0, 12]), crossing);
  // each ramps up to the ground
  for (const way of ways.filter((w) => w.floor)) {
    assert.ok(way.floor && Math.max(...way.floor) <= 98 && Math.min(...way.floor) >= 96.3 - 1e-9);
  }
  assert.ok(ways.filter((w) => w.osm === "w4" && w.floor).length === 1);
  // a path joining under the deck and ending in the cut leaves them all as they are
  const lone = bridge();
  const main = road("w6", [[0, -60], [0, 2], [0, 60]], { kind: "footway", width: 2.5 });
  const stub = road("w7", [[0, 2], [15, 2]], { kind: "footway", width: 2.5 });
  assert.equal(lowerUnderBridges([lone, main, stub], [lone], [], () => 98), 0);
  assert.equal(main.floor, undefined);
});

test("a way under a bridge with room enough stays on its ground", () => {
  const deck = bridge();
  const path = road("w2", [[0, -60], [0, 60]], { kind: "footway", width: 2.5 });
  assert.equal(lowerUnderBridges([deck, path], [deck], [], () => 95), 0);
  assert.equal(path.floor, undefined);
});


test("a way under a deck leaving the room OSM tells (its maxheight, the bridge's min_height) stays on the ground, with no cut", () => {
  // the deck's underside 4 m over the ground at 98, less than a road's 4.2 m
  const deck = road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, deck: [103, 103] });
  const tagged = road("w2", [[0, -60], [0, 60]], { kind: "primary", clearance: 4 });
  assert.equal(lowerUnderBridges([deck, tagged], [deck], [], () => 98), 0);
  assert.equal(tagged.floor, undefined);
  const told = road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, deck: [103, 103], roomUnder: 4 });
  const under = road("w3", [[0, -60], [0, 60]], { kind: "primary" });
  assert.equal(lowerUnderBridges([told, under], [told], [], () => 98), 0);
  assert.equal(under.floor, undefined);
  // a deck lower than that: the cut as without the tag
  const low = bridge();
  const short = road("w4", [[0, -60], [0, 60]], { kind: "primary", clearance: 4 });
  assert.equal(lowerUnderBridges([low, short], [low], [], () => 98), 1);
});

test("leastDecks: the deck's least top over a way under it, its room over the way's ground and its thickness, as wide as both reach", () => {
  // a 6 m wide bridge along e at n = 0 over a 9 m wide road along n at e = 0 on ground at 98
  const deck = bridge();
  const tagged = road("w2", [[0, -60], [0, 60]], { kind: "primary", width: 9, clearance: 5 });
  const untagged = road("w3", [[20, -60], [20, 60]], { kind: "primary", width: 9 });
  const least = leastDecks([deck, tagged, untagged], () => 98).get(deck) ?? [];
  // over e = -8 .. 8: the road's half width, the deck's and its edge
  const es = least.map(({ p }) => p[0]);
  assert.ok(Math.min(...es) >= -8 - 1e-9 && Math.min(...es) < -7 && Math.max(...es) <= 8 + 1e-9 && Math.max(...es) > 7);
  assert.ok(least.every(({ h }) => Math.abs(h - (98 + 5 + DECK_THICKNESS_M)) < 1e-9));
  // a way leading on from the bridge's end, meeting it or running beside it is not under it
  const leading = road("w4", [[30, 0], [90, 0]], { kind: "primary", clearance: 4 });
  const ending = road("w5", [[40, -1], [31, 0]], { kind: "primary", clearance: 4 });
  const beside = road("w6", [[-20, 5], [20, 5]], { kind: "primary", clearance: 4 });
  assert.equal(leastDecks([deck, leading, ending, beside], () => 98).get(deck), undefined);
  // a railway's deck too, over e = -6.5 .. 6.5 (its ballast's half width and edge); over a way without the room, none
  const railway: Rail = { osm: "w7", kind: "rail", layer: 1, bridge: true, tunnel: false, line: [[-30, 0], [30, 0]], deck: [100, 100] };
  const rail = leastDecks([railway, tagged], () => 98).get(railway) ?? [];
  assert.ok(rail.length > 0 && rail.every(({ p, h }) => Math.abs(p[0]) <= 6.5 + 1e-9 && Math.abs(h - (98 + 5 + DECK_THICKNESS_M)) < 1e-9));
  assert.equal(leastDecks([railway, untagged], () => 98).get(railway), undefined);
  // the bridge's min_height gives every way under it that room
  const high = road("w1", [[-30, 0], [30, 0]], { layer: 1, bridge: true, roomUnder: 4.5 });
  const room = leastDecks([high, untagged], () => 98).get(high) ?? [];
  assert.ok(room.length > 0 && room.every(({ p, h }) => Math.abs(p[0] - 20) <= 8 + 1e-9 && Math.abs(h - (98 + 4.5 + DECK_THICKNESS_M)) < 1e-9));
});

test("a way of a group whose cut is left out does not cost another way of the group, under another bridge, its cut", () => {
  // a road under the bridge along e at n = 0; another road joining it at n = 55, ending under a bridge along n at
  // e = 50, whose cut reaches back into the first road's
  const deck = bridge();
  const other = road("w4", [[50, 20], [50, 120]], { layer: 1, bridge: true, deck: [100, 100] });
  const through = road("w2", [[0, -150], [0, 55], [0, 200]], { kind: "primary" });
  const ending = road("w3", [[0, 55], [50, 55]], { kind: "primary" });
  const ways = [deck, other, through, ending];
  assert.equal(lowerUnderBridges(ways, [deck, other], [], () => 98), 1);
  assert.ok(ways.some((w) => w.osm === "w2" && w.floor));
  // the second road goes down only as far as the first one's ramp reaches into it, not under its own bridge
  assert.ok(ways.filter((w) => w.osm === "w3" && w.floor).every((w) => w.line.every(([e]) => e < 40)));
});
