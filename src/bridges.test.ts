import assert from "node:assert/strict";
import { test } from "node:test";
import { deckAt, raiseDecksOverWays, setBridgeDecks, type BridgeLine } from "./bridges.ts";
import type { Point } from "./geometry.ts";

// a river 10 m below the banks between e = 10 and e = 30
const heightAt = (e: number) => (e > 10 && e < 30 ? 90 : e <= 10 ? 100 : 104);

test("a bridge deck runs straight from the ground at one end to the other", () => {
  const bridge: BridgeLine = { bridge: true, line: [[10, 0], [20, 0], [30, 0]] };
  const road: BridgeLine = { bridge: false, line: [[0, 0], [10, 0]] };
  setBridgeDecks([road, bridge], heightAt);
  assert.deepEqual(bridge.deck, [100, 102, 104]);
  assert.equal(road.deck, undefined);
});

test("bridge ways that meet end to end form one span, whichever way they are drawn", () => {
  const a: BridgeLine = { bridge: true, line: [[20, 0], [10, 0]] };
  const b: BridgeLine = { bridge: true, line: [[20, 0], [25, 0]] };
  const c: BridgeLine = { bridge: true, line: [[30, 0], [25, 0]] };
  setBridgeDecks([b, c, a], heightAt);
  assert.deepEqual(a.deck, [102, 100]);
  assert.deepEqual(b.deck, [102, 103]);
  assert.deepEqual(c.deck, [104, 103]);
});

test("a short bridge over a hollow wider than it takes its ends' height up the ways leading on", () => {
  // an embankment at 102 with a road cut to 97 under e = 0 .. 7, smoothed out to e = -6 .. 13
  const cut = (e: number) => (e <= -6 || e >= 13 ? 102 : e < 0 ? 97 + (5 * -e) / 6 : e > 7 ? 97 + (5 * (e - 7)) / 6 : 97);
  const west: BridgeLine = { bridge: false, line: [[-40, 0], [0, 0]] };
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [7, 0]] };
  // drawn towards the bridge
  const east: BridgeLine = { bridge: false, line: [[40, 0], [7, 0]] };
  const lines = [west, bridge, east];
  setBridgeDecks(lines, cut);
  assert.deepEqual(bridge.deck, [102, 102]);
  // the approaches are split off, up to where the ground stops rising (6 m on)
  assert.equal(lines.length, 5);
  assert.deepEqual(west.line, [[-40, 0], [-6, 0]]);
  assert.deepEqual(east.line, [[40, 0], [13, 0]]);
  const [westRamp, eastRamp] = lines.slice(3);
  assert.deepEqual([westRamp.line, westRamp.deck, westRamp.bridge], [[[-6, 0], [0, 0]], [102, 102], false]);
  assert.deepEqual([eastRamp.line, eastRamp.deck], [[[13, 0], [7, 0]], [102, 102]]);
});

test("a bridge's end at the bottom of a hollow reaching past it takes its height from where the ground stops rising", () => {
  // the hollow's level bottom at 100 goes on 4 m past the bridge's west end; the bank rises to 110 by e = -18
  const hollow = (e: number) => (e >= -4 ? 100 : e <= -18 ? 110 : 100 + ((-4 - e) * 10) / 14);
  const west: BridgeLine = { bridge: false, line: [[-60, 0], [0, 0]] };
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [10, 0]] };
  const lines = [west, bridge];
  setBridgeDecks(lines, hollow);
  // the east end, with no way on, stays on the ground
  assert.deepEqual(bridge.deck, [110, 100]);
  assert.deepEqual(west.line, [[-60, 0], [-18, 0]]);
});

test("the ground falling away from a bridge's end leaves the ways leading on as they are", () => {
  const road: BridgeLine = { bridge: false, line: [[0, 0], [10, 0]] };
  const bridge: BridgeLine = { bridge: true, line: [[10, 0], [20, 0], [30, 0]] };
  const lines = [road, bridge];
  setBridgeDecks(lines, heightAt);
  assert.equal(lines.length, 2);
  assert.equal(road.deck, undefined);
});

test("a deck never goes below the ground", () => {
  const hill = (e: number) => (e === 5 ? 120 : 100);
  const bridge: BridgeLine = { bridge: true, line: [[0, 0], [5, 0], [10, 0]] };
  setBridgeDecks([bridge], hill);
  assert.deepEqual(bridge.deck, [100, 120, 100]);
});

test("deckAt interpolates along the nearest segment", () => {
  const line: Point[] = [[0, 0], [10, 0], [10, 10]];
  const deck = [100, 110, 90];
  assert.equal(deckAt(line, deck, [5, 0]), 105);
  assert.equal(deckAt(line, deck, [10, 5]), 100);
  assert.equal(deckAt(line, deck, [0, 0]), 100);
});

test("a junction on a bridge (a ramp leaving it) hangs between the bridge's ends, not on the ground under it", () => {
  // ground 100 at both ends, 80 under the middle, where a ramp leaves the bridge
  const ground = (e: number) => (e <= 0 || e >= 100 ? 100 : 80);
  const west: BridgeLine = { bridge: true, line: [[0, 0], [50, 0]] };
  const east: BridgeLine = { bridge: true, line: [[50, 0], [100, 0]] };
  const ramp: BridgeLine = { bridge: true, line: [[50, 0], [100, 20]] };
  const lines = [{ bridge: false, line: [[-20, 0], [0, 0]] satisfies Point[] }, west, east, ramp, { bridge: false, line: [[100, 0], [120, 0]] satisfies Point[] }];
  setBridgeDecks(lines, ground);
  const round = (deck: number[] | undefined) => deck?.map((h) => Math.round(h * 100) / 100);
  assert.deepEqual([round(west.deck), round(east.deck), round(ramp.deck)], [[100, 100], [100, 100], [100, 100]]);
});

test("raiseDecksOverWays lifts a deck over a way under it to leave its room, and leaves a high one as it is", () => {
  // a footbridge 30 m long from the ground at 100 on both ends, over a tram at 98 and a path on the ground
  const bridge = { osm: "w1", kind: "footway", width: 3, layer: 1, bridge: true, tunnel: false, line: [[0, 0], [30, 0]] as Point[], deck: [100, 100] };
  const tram = { osm: "w2", kind: "tram", layer: 0, bridge: false, tunnel: false, line: [[10, -20], [10, 20]] as Point[] };
  const high = { ...bridge, osm: "w3", line: [[0, 10], [30, 10]] as Point[], deck: [107, 107] };
  assert.equal(raiseDecksOverWays([bridge, high], [bridge, high, tram], () => 98), 1);
  // a point over the tram, 4.7 m and the deck's 1 m over it
  assert.deepEqual(bridge.line, [[0, 0], [10, 0], [30, 0]]);
  assert.deepEqual(bridge.deck, [100, 98 + 4.7 + 1, 100]);
  assert.deepEqual(high.deck, [107, 107]);
});
