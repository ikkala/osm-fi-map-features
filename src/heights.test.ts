import assert from "node:assert/strict";
import { test } from "node:test";
import { deckAt } from "./bridges.ts";
import { nearestOnLine, RESOLUTION_M, type Point } from "./geometry.ts";
import { solveHeights } from "./heights.ts";
import { loadLp } from "./lp.ts";
import type { MapFeatures, Rail, Road } from "./osm.ts";
import { defined } from "./testing.ts";
import { BEND_SPAN_M, MAX_BEND_M, type Way } from "./ways.ts";

const lp = await loadLp();

function road(osm: string, line: Point[], extra: Partial<Road> = {}): Road {
  return { osm, kind: "footway", width: 2.5, layer: 0, bridge: false, tunnel: false, line, ...extra };
}

/** Solves the heights of the roads and rails over the ground, the pieces split off pushed onto them */
function solve(roads: Road[], ground: (e: number, n: number) => number | undefined, rails: Rail[] = []): MapFeatures {
  const features: MapFeatures = { roads, rails, buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  solveHeights(features, ground, lp);
  return features;
}

/** The height of the pieces of `osm` at a point of theirs (their deck or floor, else the ground's) */
function heightAt(ways: Way[], osm: string, p: Point, ground: number): number | undefined {
  const pieces = ways.filter((w) => w.osm === osm && nearestOnLine(w.line, p).distance < 1e-6);
  const piece = pieces.find((w) => w.deck ?? w.floor) ?? pieces[0];
  const heights = piece?.deck ?? piece?.floor;
  return piece && (heights ? deckAt(piece.line, heights, p) : ground);
}

/** The most a line's heights bend from the line between them `span` m before and after, looked at every half meter */
function mostBend(line: Point[], heights: number[], span = 10): number {
  const along = line.map((_, i) => (i === 0 ? 0 : 0));
  line.forEach((p, i) => i > 0 && (along[i] = along[i - 1] + Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1])));
  const at = (d: number) => {
    const i = Math.max(1, along.findIndex((x) => x >= d));
    const t = (d - along[i - 1]) / (along[i] - along[i - 1] || 1);
    return heights[i - 1] + (heights[i] - heights[i - 1]) * t;
  };
  let most = 0;
  for (let d = span; d <= (along.at(-1) ?? 0) - span; d += 0.5) {
    most = Math.max(most, Math.abs(at(d) - (at(d - span) + at(d + span)) / 2));
  }
  return most;
}

test("an approach is as long as its rise needs: a deck raised 6 m for the room told under it comes down at its users' grade, on through the joints of its line", () => {
  // a footbridge over a path with 5 m of room told, its west approach three ways joined end to end
  const flat = () => 100;
  const ways = [
    road("w1", [[-200, 0], [-60, 0]]),
    road("w2", [[-60, 0], [-20, 0]]),
    road("w3", [[-20, 0], [0, 0]]),
    road("w4", [[0, 0], [40, 0]], { bridge: true, layer: 1 }),
    road("w5", [[40, 0], [240, 0]]),
    road("w6", [[20, -50], [20, 50]], { clearance: 5 }),
  ];
  const { roads } = solve(ways, flat);
  const deck = defined(ways[3].deck);
  assert.ok(Math.max(...deck) >= 106 - 0.01, `${deck}`);
  // west: down from the landing to the ground through w3, w2 and into w1, no steeper than 8 % and no shorter than that needs
  const west = (e: number) => Math.max(...["w1", "w2", "w3"].map((osm) => heightAt(roads, osm, [e, 0], 100) ?? 100));
  for (let e = -198; e <= 0; e += 2) {
    assert.ok(Math.abs(west(e) - west(e - 2)) <= 0.08 * 2 + 1e-6, `${e}: ${west(e - 2)} ${west(e)}`);
  }
  assert.ok(west(-40) > 100.5 && west(-200) === 100);
});

test("a cut's floor is a smooth line, not the ground's bends: off the ground it bends no more than MAX_BEND_M over 10 m, where it meets the ground a little more", () => {
  // a path under a road bridge too low over it, the ground under the path rippling a metre every 16 m
  const wavy = (e: number, n: number) => (Math.abs(e) >= 30 ? 100 : 98 + 0.5 * Math.sin((n * Math.PI) / 8));
  const bridge = road("w1", [[-30, 0], [30, 0]], { kind: "residential", width: 6, bridge: true, layer: 1 });
  const path = road("w2", [[0, -80], [0, 80]]);
  const { roads } = solve([bridge, path], wavy);
  const cuts = roads.filter((w) => w.osm === "w2" && w.floor);
  assert.ok(cuts.length > 0);
  for (const cut of cuts) {
    // the ground under it bends 0.7 m so
    assert.ok(mostBend(cut.line, defined(cut.floor)) <= 1.5 * MAX_BEND_M, `${mostBend(cut.line, defined(cut.floor))}`);
  }
});

test("a way crossing a cut keeps its own heights: the cut is held at the ground where they meet, and level with it across the way's room", () => {
  // a street in a cut under a footbridge, a path across it 6 m from the deck
  const flat = (e: number) => (Math.abs(e) >= 30 ? 100 : 98.5);
  const bridge = road("w1", [[-30, 0], [30, 0]], { bridge: true, layer: 1, width: 4 });
  const street = road("w2", [[0, -80], [0, 9], [0, 80]], { kind: "residential", width: 7 });
  const path = road("w3", [[-40, 9], [0, 9], [40, 9]]);
  const { roads } = solve([bridge, street, path], flat);
  const streetAt = (n: number) => defined(heightAt(roads, "w2", [0, n], 98.5));
  assert.ok(streetAt(0) < 98.5 - 0.5, `${streetAt(0)}`);
  assert.deepEqual([streetAt(9), heightAt(roads, "w3", [0, 9], 98.5)], [98.5, 98.5]);
  assert.ok(roads.filter((w) => w.osm === "w3").every((w) => w.floor === undefined));
  // the path's surface across the street's room, a little either side of their junction, at the street's floor there
  for (const n of [8, 10]) {
    assert.ok(Math.abs(streetAt(n) - 98.5) <= RESOLUTION_M, `${n}: ${streetAt(n)}`);
  }
});

test("a ramp out of a tunnel solved with the deck over it: it goes down under the deck from the tunnel's floor at the portal, the deck staying on its landings' line, the room it cannot reach told", () => {
  // an underpass under a hill; its way out east passes under a footbridge's deck 10 m from the portal
  const ground = (e: number, n: number) => (Math.abs(n) >= 20 && e > 0 ? 100 : e < 0 ? 104 : 100);
  const tunnel = road("w1", [[-60, 0], [0, 0]], { tunnel: true, layer: -1, width: 3 });
  const west = road("w2", [[-100, 0], [-60, 0]]);
  const out = road("w3", [[0, 0], [80, 0]]);
  const bridge = road("w4", [[10, -20], [10, 20]], { bridge: true, layer: 1, width: 3 });
  const features: MapFeatures = { roads: [west, tunnel, out, bridge], rails: [], buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  const { conflicts } = solveHeights(features, ground, lp);
  const { roads } = features;
  const floor = defined(tunnel.floor).at(-1) ?? Infinity;
  const ramp = defined(roads.find((w) => w.osm === "w3" && w.floor));
  assert.equal(defined(ramp.floor)[0], floor);
  const under = defined(heightAt(roads, "w3", [10, 0], 100));
  const deck = deckAt(bridge.line, defined(bridge.deck), [10, 0]);
  assert.ok(Math.abs(deck - 100) < 1e-6 && under < 100 - 2, `deck ${deck}, under it ${under}`);
  const missed = conflicts.find((c) => c.bound === "room" && c.way === "w4");
  assert.ok(missed && Math.abs(missed.by - (under - (deck - 1 - 2.7))) < 0.06, JSON.stringify(conflicts));
  const heights = defined(ramp.floor);
  heights.slice(1).forEach((h, i) => assert.ok(Math.abs(h - heights[i]) <= 0.6 * Math.hypot(ramp.line[i + 1][0] - ramp.line[i][0], ramp.line[i + 1][1] - ramp.line[i][1]) + 1e-6));
});

test("a cut under a railway's deck, which keeps to its landings, is held at the ground where paths cross it, which keep theirs", () => {
  // a track under a railway bridge landing at 100, paths crossing it either side of the deck
  const ground = (e: number) => (Math.abs(e) >= 15 ? 100 : 99);
  const railway: Rail = { osm: "w1", kind: "rail", layer: 1, bridge: true, tunnel: false, line: [[-15, 0], [15, 0]] };
  const rails = [railway, { osm: "w5", kind: "rail", layer: 0, bridge: false, tunnel: false, line: [[-80, 0], [-15, 0]] } satisfies Rail, { osm: "w6", kind: "rail", layer: 0, bridge: false, tunnel: false, line: [[15, 0], [80, 0]] } satisfies Rail];
  const track = road("w2", [[0, -80], [0, -8], [0, 8], [0, 80]], { kind: "track", width: 3 });
  const paths = [road("w3", [[-30, -8], [0, -8], [30, -8]]), road("w4", [[-30, 8], [0, 8], [30, 8]])];
  const { roads } = solve([track, ...paths], ground, rails);
  assert.ok([defined(railway.deck)[0], defined(railway.deck).at(-1)].every((h) => Math.abs((h ?? 0) - 100) < 1e-6));
  const trackAt = (n: number) => defined(heightAt(roads, "w2", [0, n], 99));
  assert.ok(trackAt(0) < 99 - 0.1, `${trackAt(0)}`);
  for (const [osm, n] of [["w3", -8], ["w4", 8]] as const) {
    assert.deepEqual([trackAt(n), heightAt(roads, osm, [0, n], 99)], [99, 99]);
    assert.ok(roads.filter((w) => w.osm === osm).every((w) => w.floor === undefined));
  }
});

test("a solved line, its heights rounded to the tiles' resolution, bends no more than MAX_BEND_M over BEND_SPAN_M", () => {
  // a road in a cut 2 m deep under a footbridge, on level ground
  const ground = () => 100;
  const bridge = road("w1", [[-20, 0], [20, 0]], { bridge: true, layer: 1, width: 3 });
  const street = road("w2", [[0, -150], [0, 150]], { kind: "residential", width: 6 });
  const landings = [road("w3", [[-60, 0], [-20, 0]]), road("w4", [[20, 0], [60, 0]])];
  const { roads } = solve([bridge, street, ...landings], ground);
  const cuts = roads.filter((w) => w.osm === "w2" && w.floor);
  assert.ok(cuts.some((w) => Math.min(...defined(w.floor)) < 100 - 1));
  for (const cut of cuts) {
    const rounded = defined(cut.floor).map((h) => Math.round(h / RESOLUTION_M) * RESOLUTION_M);
    assert.ok(mostBend(cut.line, rounded, BEND_SPAN_M) <= MAX_BEND_M + 1e-9, `${mostBend(cut.line, rounded, BEND_SPAN_M)}`);
  }
});

test("a railway's deck over a road with the room under it told rises to give it, its approaches climbing at the railway's grade, the road on its ground", () => {
  // a tram bridge over a road with 5 m told under it, on level ground at 100, the tracks on the ground either side
  const flat = () => 100;
  const tram = (osm: string, line: Point[], bridge = false): Rail => ({ osm, kind: "tram", layer: bridge ? 1 : 0, bridge, tunnel: false, line });
  const deck = tram("w1", [[-10, 0], [10, 0]], true);
  const rails = [tram("w2", [[-300, 0], [-10, 0]]), deck, tram("w3", [[10, 0], [300, 0]])];
  const street = road("w4", [[0, -50], [0, 50]], { kind: "trunk", width: 8, clearance: 5 });
  const { roads, rails: solved } = solve([street], flat, rails);
  assert.ok(deckAt(deck.line, defined(deck.deck), [0, 0]) >= 106 - 0.05, `${deck.deck}`);
  assert.ok(roads.filter((w) => w.osm === "w4").every((w) => w.floor === undefined));
  // the approaches no steeper than a tram's grade, down to the ground
  for (const approach of solved.filter((w) => w.osm !== "w1" && w.deck)) {
    const heights = defined(approach.deck);
    heights.slice(1).forEach((h, i) => assert.ok(Math.abs(h - heights[i]) <= 0.03 * Math.abs(approach.line[i + 1][0] - approach.line[i][0]) + 0.01, `${approach.osm} ${heights}`));
    assert.ok(Math.abs(Math.min(...heights) - 100) < 1e-6);
  }
});

test("the tracks on one bridge outline keep one deck across: a clearance told under one raises both", () => {
  const flat = () => 100;
  const tram = (osm: string, line: Point[], bridge = false): Rail => ({ osm, kind: "tram", layer: bridge ? 1 : 0, bridge, tunnel: false, line });
  // two tracks 4 m apart on an outline 12 m wide; a road with 5 m told under the north track only, ending under it
  const north = tram("w1", [[-10, 2], [10, 2]], true);
  const south = tram("w2", [[-10, -2], [10, -2]], true);
  const rails = [tram("w3", [[-300, 2], [-10, 2]]), north, tram("w4", [[10, 2], [300, 2]]), tram("w5", [[-300, -2], [-10, -2]]), south, tram("w6", [[10, -2], [300, -2]])];
  const street = road("w7", [[0, 40], [0, 1]], { kind: "trunk", width: 4, clearance: 5 });
  const features: MapFeatures = { roads: [street], rails, buildings: [], areas: [], trees: [], lamps: [], crossings: [], signals: [], gates: [], barriers: [], playEquipment: [], bridgeDecks: [] };
  solveHeights(features, flat, lp, { outlines: [{ osm: "w8", polygon: { outer: [[-10, -6], [10, -6], [10, 6], [-10, 6]], holes: [] } }] });
  const [n, s] = [deckAt(north.line, defined(north.deck), [0, 2]), deckAt(south.line, defined(south.deck), [0, -2])];
  assert.ok(n > 104 && Math.abs(n - s) < 0.05, `${n} ${s}`);
});

test("a ramp goes on into no way of a deck's: at a joint onto a bridge's approach it is held at the ground, the approach raised from its landing", () => {
  // an underpass under a street on level ground at 100, its way out east joining a bridge's approach 10 m out
  const flat = () => 100;
  const tunnel = road("w1", [[-12, 0], [0, 0]], { tunnel: true, layer: -1 });
  const ways = [road("w0", [[-60, 0], [-12, 0]]), tunnel, road("w2", [[0, 0], [10, 0]]), road("w3", [[10, 0], [110, 0]]), road("w4", [[110, 0], [150, 0]], { bridge: true, layer: 1 }), road("w5", [[150, 0], [300, 0]])];
  const { roads } = solve([...ways, road("w6", [[-6, -20], [-6, 20]], { kind: "residential", width: 6 }), road("w7", [[130, -30], [130, 30]], { clearance: 5 })], flat);
  const ramp = defined(roads.find((w) => w.osm === "w2" && w.floor));
  assert.deepEqual([ramp.line.at(-1), defined(ramp.floor).at(-1)], [[10, 0], 100]);
  assert.ok(roads.filter((w) => w.osm === "w3").every((w) => w.floor === undefined) && roads.some((w) => w.osm === "w3" && w.deck));
});
